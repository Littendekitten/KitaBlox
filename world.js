/* =========================================================================================
   KITABLOX WORLD MODULE
   Seeded terrain noise, the block data store, GPU-instanced chunk rendering, and the
   infinite chunk streaming system. Depends on THREE + graphics.js (blockMaterials).
   Consumed by engine.js (camera/physics/input loop calls into generateWorld, setBlock,
   refreshChunkStreaming, processChunkQueue).

   NOTE: streaming/spawn logic here tracks the player via the `playerPos` vector (the
   true player position), NOT `camera.position`. The two are no longer the same thing:
   engine.js can point the actual render camera somewhere else entirely (behind/in front
   of the player) for third-person perspective, so world streaming must follow the player,
   not the camera.

   PERFORMANCE NOTES (this file is where most of the "no lag" work lives):
   - meshList (used every frame for raycasting) used to be rebuilt with Object.values()
     on *every single* setBlock() call -- including the hundreds of thousands of calls
     made while generating terrain. It's now only rebuilt when the set of instanced
     meshes actually changes (a new block type appears, or one is grown), which is rare.
   - processChunkQueue() used to generate a fixed number of chunks per frame regardless
     of device speed, which either wasted headroom on fast machines or caused hitches on
     slow ones. It now works off a small per-frame time budget instead, so loading speed
     adapts automatically and never eats an entire frame.
   ========================================================================================= */

// 2. SEEDED NOISE (deterministic terrain from a single 32-bit seed, no external libs)
function hashSeedString(str) {
  str = String(str);
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return (h ^ (h >>> 16)) >>> 0;
}

function resolveSeed(input) {
  input = (input || '').trim();
  if (!input) return (Math.random() * 4294967296) >>> 0;
  if (/^-?\d+$/.test(input)) return (parseInt(input, 10) >>> 0);
  return hashSeedString(input);
}

// mulberry32: tiny, fast, good-enough PRNG for terrain/placement randomness
function makeSeededRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Classic seeded gradient (Perlin-style) 2D noise, built from the seeded PRNG
function createPerlin2D(seed) {
  const rand = makeSeededRandom(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + t * (b - a);
  const gx = [1, -1, 1, -1, 1, -1, 0, 0], gy = [1, 1, -1, -1, 0, 0, 1, -1];
  const grad = (hash, x, y) => { const h = hash & 7; return gx[h] * x + gy[h] * y; };

  return function perlin2(x, y) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = fade(xf), v = fade(yf);
    const aa = perm[perm[X] + Y], ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y], bb = perm[perm[X + 1] + Y + 1];
    const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
    const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  };
}

// Fractal sum of a few octaves for natural-looking rolling hills
function makeHeightFn(seed) {
  const noise = createPerlin2D(seed);
  return function heightAt(x, z) {
    let h = 0;
    h += noise(x * 0.045, z * 0.045) * 6;         // rolling hills
    h += noise(x * 0.09 + 50, z * 0.09 + 50) * 3;  // smaller bumps
    h += noise(x * 0.015 - 80, z * 0.015 - 80) * 5; // broad continent-scale rise
    return Math.round(h);
  };
}

// 3. WORLD DATA & GPU-INSTANCED CHUNK RENDERING
// Instead of one THREE.Mesh per block (which chokes the renderer once you have
// more than a few thousand blocks), each block *type* gets a single
// THREE.InstancedMesh. Adding/removing a block just writes one 4x4 matrix into
// that type's instance buffer, so worlds with tens of thousands of blocks stay smooth.
const worldBlocks = {};       // "x,y,z" -> block type (source of truth, used for physics/lookups)
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
let instancedMeshes = {};     // type -> THREE.InstancedMesh
let instanceState = {};       // type -> { capacity, count, keyToIndex, indexToKey }
let meshList = [];            // cached array of instanced meshes, for raycasting -- only
                               // rebuilt when the mesh set itself changes (see note above)
const dummy = new THREE.Object3D();
const EDIT_BUFFER = 3000;     // spare instance slots per type reserved for player building
const WATER_LEVEL = -3;
let currentSeed = null;

// ---- Infinite streamed world ----
// The world has no fixed size. Terrain is generated in 16x16 chunks around the
// player as they move, and chunks that fall far behind get unloaded again, so the
// number of live blocks stays roughly constant (and small) no matter how far you walk.
const CHUNK_SIZE = 16;
const RENDER_DISTANCE = 5;              // chunks loaded outward from the player (radius)
const WORLD_BORDER = 10000000;          // hard block-coordinate limit (like a Minecraft world border)
const MAX_CHUNK_COORD = Math.floor(WORLD_BORDER / CHUNK_SIZE);
const MAX_LOADED_COLUMNS = (2 * RENDER_DISTANCE + 3) * (2 * RENDER_DISTANCE + 3) * CHUNK_SIZE * CHUNK_SIZE;
const CHUNK_FRAME_BUDGET_MS = 6;        // time budget per frame for chunk generation --
                                         // adapts to device speed instead of a fixed chunk
                                         // count, so loading never eats a whole frame

let heightAtFn = null;
let loadedChunks = new Map();  // "cx,cz" -> array of block keys owned by that chunk (for clean unload)
let queuedChunks = new Set();  // "cx,cz" currently waiting in chunkLoadQueue
let chunkLoadQueue = [];       // [{cx, cz}], closest-first
let currentChunkX = null, currentChunkZ = null;

function chunkKeyOf(cx, cz) { return cx + ',' + cz; }

function getBlockKey(x, y, z) { return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`; }

function rebuildMeshList() {
  meshList = Object.values(instancedMeshes);
}

function createInstancedMesh(type, capacity) {
  capacity = Math.max(capacity, EDIT_BUFFER);
  const meshInst = new THREE.InstancedMesh(boxGeo, blockMaterials[type], capacity);
  meshInst.count = 0;
  meshInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  meshInst.frustumCulled = false; // shared 1-unit box geometry has a tiny bounding sphere; avoid wrongly culling the whole world
  meshInst.userData.type = type;
  scene.add(meshInst);
  instancedMeshes[type] = meshInst;
  instanceState[type] = { capacity, count: 0, keyToIndex: new Map(), indexToKey: new Map() };
  rebuildMeshList();
  return meshInst;
}

function growInstancedMesh(type, newCapacity) {
  const oldMesh = instancedMeshes[type];
  const state = instanceState[type];
  const newMesh = new THREE.InstancedMesh(boxGeo, blockMaterials[type], newCapacity);
  newMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  newMesh.frustumCulled = false;
  newMesh.userData.type = type;
  for (let i = 0; i < state.count; i++) {
    oldMesh.getMatrixAt(i, dummy.matrix);
    newMesh.setMatrixAt(i, dummy.matrix);
  }
  newMesh.count = state.count;
  scene.remove(oldMesh);
  scene.add(newMesh);
  instancedMeshes[type] = newMesh;
  state.capacity = newCapacity;
  rebuildMeshList();
}

function clearWorld() {
  Object.values(instancedMeshes).forEach(m => scene.remove(m));
  instancedMeshes = {};
  instanceState = {};
  for (const k in worldBlocks) delete worldBlocks[k];
  meshList = [];
  loadedChunks = new Map();
  queuedChunks = new Set();
  chunkLoadQueue = [];
}

function removeInstance(type, key) {
  const state = instanceState[type];
  if (!state) return;
  const idx = state.keyToIndex.get(key);
  if (idx === undefined) return;
  const meshInst = instancedMeshes[type];
  const lastIdx = state.count - 1;
  if (idx !== lastIdx) {
    meshInst.getMatrixAt(lastIdx, dummy.matrix);
    meshInst.setMatrixAt(idx, dummy.matrix);
    const lastKey = state.indexToKey.get(lastIdx);
    state.keyToIndex.set(lastKey, idx);
    state.indexToKey.set(idx, lastKey);
  }
  state.keyToIndex.delete(key);
  state.indexToKey.delete(lastIdx);
  state.count--;
  meshInst.count = state.count;
  meshInst.instanceMatrix.needsUpdate = true;
}

function addInstance(type, key, x, y, z) {
  let state = instanceState[type];
  if (!state) createInstancedMesh(type, EDIT_BUFFER), state = instanceState[type];
  if (state.count >= state.capacity) growInstancedMesh(type, state.capacity + 1000), state = instanceState[type];
  const meshInst = instancedMeshes[type];
  const idx = state.count;
  dummy.position.set(x, y, z);
  dummy.rotation.set(0, 0, 0);
  dummy.scale.set(1, 1, 1);
  dummy.updateMatrix();
  meshInst.setMatrixAt(idx, dummy.matrix);
  state.keyToIndex.set(key, idx);
  state.indexToKey.set(idx, key);
  state.count++;
  meshInst.count = state.count;
  meshInst.instanceMatrix.needsUpdate = true;
}

function setBlock(x, y, z, type) {
  x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
  const key = getBlockKey(x, y, z);
  const existingType = worldBlocks[key];
  if (existingType !== undefined) removeInstance(existingType, key);

  if (type === 0) {
    delete worldBlocks[key];
    return;
  }
  worldBlocks[key] = type;
  addInstance(type, key, x, y, z);
  // NOTE: meshList is intentionally NOT rebuilt here. It only ever needs to change when
  // a new block type's InstancedMesh is created or grown (handled inside
  // createInstancedMesh/growInstancedMesh above), not on every single block edit --
  // rebuilding it here was allocating a fresh array on every block placed during terrain
  // generation and was the single biggest source of loading-time jank.
}

function createTree(trX, trY, trZ, rand) {
  rand = rand || Math.random;
  const placed = [];
  for (let y = 0; y < 4; y++) {
    setBlock(trX, trY + y, trZ, 4);
    placed.push(getBlockKey(trX, trY + y, trZ));
  }
  for (let lx = -2; lx <= 2; lx++) {
    for (let lz = -2; lz <= 2; lz++) {
      for (let ly = 2; ly <= 4; ly++) {
        if (Math.abs(lx) === 2 && Math.abs(lz) === 2 && rand() > 0.4) continue;
        const key = getBlockKey(trX + lx, trY + ly, trZ + lz);
        if (!worldBlocks[key]) {
          setBlock(trX + lx, trY + ly, trZ + lz, 5);
          placed.push(key);
        }
      }
    }
  }
  return placed;
}

// Generates one 16x16 chunk of terrain (+ any trees fully contained in it) and
// records every block key it placed, so the chunk can be cleanly unloaded later.
// Each chunk gets its own deterministic PRNG derived from (seed, cx, cz), so chunks
// generate identically no matter what order they load in.
function loadChunk(cx, cz) {
  const key = chunkKeyOf(cx, cz);
  if (loadedChunks.has(key)) return;

  const baseX = cx * CHUNK_SIZE, baseZ = cz * CHUNK_SIZE;
  const chunkSeed = hashSeedString(currentSeed + ':' + cx + ':' + cz);
  const rand = makeSeededRandom(chunkSeed);
  const blocks = [];

  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      const x = baseX + lx, z = baseZ + lz;
      if (Math.abs(x) > WORLD_BORDER || Math.abs(z) > WORLD_BORDER) continue;

      const h = heightAtFn(x, z);
      const top = h <= WATER_LEVEL ? 6 : 1; // sandy low ground, grassy elsewhere
      setBlock(x, h, z, top); blocks.push(getBlockKey(x, h, z));
      setBlock(x, h - 1, z, 2); blocks.push(getBlockKey(x, h - 1, z));
      setBlock(x, h - 2, z, 2); blocks.push(getBlockKey(x, h - 2, z));
      for (let y = h - 3; y >= h - 6; y--) { setBlock(x, y, z, 3); blocks.push(getBlockKey(x, y, z)); }

      // Keep tree canopies (+-2) fully inside their own chunk so unloading never
      // leaves holes in a neighboring, still-loaded chunk.
      const inCanopyMargin = lx >= 2 && lx <= CHUNK_SIZE - 3 && lz >= 2 && lz <= CHUNK_SIZE - 3;
      if (inCanopyMargin && x % 5 === 0 && z % 5 === 0 && rand() > 0.5 && Math.abs(x) > 2 && Math.abs(z) > 2) {
        blocks.push(...createTree(x, h + 1, z, rand));
      }
    }
  }

  loadedChunks.set(key, blocks);
}

function unloadChunk(cx, cz) {
  const key = chunkKeyOf(cx, cz);
  const blocks = loadedChunks.get(key);
  if (!blocks) return;
  for (const bkey of blocks) {
    if (worldBlocks[bkey] !== undefined) {
      const [bx, by, bz] = bkey.split(',').map(Number);
      setBlock(bx, by, bz, 0);
    }
  }
  loadedChunks.delete(key);
}

// Recomputes which chunks should be loaded/unloaded whenever the player crosses
// into a new chunk. Unloads happen immediately (cheap); loads are queued and
// trickled in over the following frames (see processChunkQueue) so the game never hitches.
function refreshChunkStreaming() {
  const ccx = Math.floor(playerPos.x / CHUNK_SIZE);
  const ccz = Math.floor(playerPos.z / CHUNK_SIZE);
  if (ccx === currentChunkX && ccz === currentChunkZ) return;
  currentChunkX = ccx; currentChunkZ = ccz;

  for (const key of Array.from(loadedChunks.keys())) {
    const [cx, cz] = key.split(',').map(Number);
    if (Math.abs(cx - ccx) > RENDER_DISTANCE + 1 || Math.abs(cz - ccz) > RENDER_DISTANCE + 1) {
      unloadChunk(cx, cz);
    }
  }

  const wanted = [];
  for (let dx = -RENDER_DISTANCE; dx <= RENDER_DISTANCE; dx++) {
    for (let dz = -RENDER_DISTANCE; dz <= RENDER_DISTANCE; dz++) {
      const cx = ccx + dx, cz = ccz + dz;
      if (Math.abs(cx) > MAX_CHUNK_COORD || Math.abs(cz) > MAX_CHUNK_COORD) continue;
      const key = chunkKeyOf(cx, cz);
      if (loadedChunks.has(key) || queuedChunks.has(key)) continue;
      wanted.push({ cx, cz, d: dx * dx + dz * dz });
    }
  }
  wanted.sort((a, b) => a.d - b.d);
  for (const w of wanted) { chunkLoadQueue.push(w); queuedChunks.add(chunkKeyOf(w.cx, w.cz)); }
}

// Trickles queued chunks in using a small time budget rather than a fixed count per
// frame: fast devices naturally load more chunks/frame, slow devices load fewer, and
// either way a single frame never gets stuck doing more generation work than it can
// afford -- this is what keeps world streaming from ever causing a visible stutter.
function processChunkQueue() {
  if (!chunkLoadQueue.length) return;
  const start = performance.now();
  while (chunkLoadQueue.length && (performance.now() - start) < CHUNK_FRAME_BUDGET_MS) {
    const { cx, cz } = chunkLoadQueue.shift();
    queuedChunks.delete(chunkKeyOf(cx, cz));
    loadChunk(cx, cz);
  }
}

// (Re)starts the world from a seed: resets all streaming state, allocates fixed
// (generous, one-time) InstancedMesh capacities sized for RENDER_DISTANCE -- not
// for the whole world, since only a window of it is ever loaded at once -- and
// synchronously loads the chunks right around spawn so the player doesn't fall
// through the void while the rest streams in over the following frames.
function generateWorld(seedInput) {
  clearWorld();
  const seed = resolveSeed(seedInput);
  currentSeed = seed;
  heightAtFn = makeHeightFn(seed);

  createInstancedMesh(1, MAX_LOADED_COLUMNS + EDIT_BUFFER);       // grass
  createInstancedMesh(2, MAX_LOADED_COLUMNS * 2 + EDIT_BUFFER);   // dirt
  createInstancedMesh(3, MAX_LOADED_COLUMNS * 4 + EDIT_BUFFER);   // stone
  createInstancedMesh(4, 3000 + EDIT_BUFFER);                     // wood
  createInstancedMesh(5, 45000 + EDIT_BUFFER);                    // leaves
  createInstancedMesh(6, MAX_LOADED_COLUMNS + EDIT_BUFFER);       // sand
  createInstancedMesh(7, EDIT_BUFFER);                            // glass (placed only)

  playerPos.set(0, heightAtFn(0, 0) + 8, 0);
  velocity.set(0, 0, 0);
  yVel = 0;
  isGrounded = false;

  currentChunkX = null; currentChunkZ = null;
  refreshChunkStreaming();
  const spawnRadius = 2; // chunks loaded synchronously before the world is shown
  const spawnCount = Math.min(chunkLoadQueue.length, (2 * spawnRadius + 1) * (2 * spawnRadius + 1));
  for (let i = 0; i < spawnCount; i++) {
    const { cx, cz } = chunkLoadQueue.shift();
    queuedChunks.delete(chunkKeyOf(cx, cz));
    loadChunk(cx, cz);
  }
  playerPos.set(0, heightAtFn(0, 0) + 8, 0);
  // Snap the render camera to the new spawn point immediately (rather than waiting
  // for the next animate() frame) so there's never a stray frame looking at the origin.
  if (typeof updateCameraTransform === 'function') updateCameraTransform();
  return seed;
}
