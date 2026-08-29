/* =========================================================================================
   KITABLOX ENGINE MODULE
   Scene/camera/renderer setup, pointer-lock input, hotbar selection, break/place particles,
   player physics + collision, and the main requestAnimationFrame loop. Depends on THREE,
   PointerLockControls, graphics.js (blockMaterials) and world.js (worldBlocks, setBlock,
   generateWorld, refreshChunkStreaming, processChunkQueue, CHUNK_SIZE, RENDER_DISTANCE).

   PERFORMANCE NOTES:
   - checkCollision() used to allocate a brand new THREE.Box3 + THREE.Vector3 for the
     player AND for every single candidate block it tested (up to ~45 per axis check,
     called on every axis every frame) -- that's thousands of short-lived objects per
     second, which is exactly the kind of garbage that causes the GC to pause and drop
     frames ("stutter"). Those boxes are now pooled/reused instead of reallocated.
   - The break-particle box geometry used to be recreated on every single block break;
     it's now created once and shared, since all particles use the same 0.15^3 cube.
   - Fog density and the camera's far plane are now derived from RENDER_DISTANCE so the
     world fades out right around where chunks stream in/out, instead of a mismatched
     fixed value that made streaming pop-in visible.
   ========================================================================================= */

// 4. ENGINE & SCENE SETUP
let scene, camera, renderer, controls, raycaster, highlightBox;
let particles = [];
let activeBlockType = 1;
let lastFrameTime = performance.now();
let fpsAccum = 0, fpsFrames = 0;

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x7ec0ee);
  // Fade distance matches how far terrain is actually streamed in, so chunks never
  // visibly pop in/out at the edge of render distance -- they fade into the fog instead.
  const fogDistance = RENDER_DISTANCE * CHUNK_SIZE;
  scene.fog = new THREE.FogExp2(0x7ec0ee, 4.6 / fogDistance);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, fogDistance + CHUNK_SIZE * 3);
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  document.body.appendChild(renderer.domElement);

  // Sun & Hemisphere Lighting
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444455, 0.7);
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
  dirLight.position.set(40, 60, 20);
  scene.add(dirLight);

  controls = new THREE.PointerLockControls(camera, document.body);
  raycaster = new THREE.Raycaster();
  raycaster.far = 7;

  // Selection Wireframe Highlight
  const wireGeo = new THREE.BoxGeometry(1.005, 1.005, 1.005);
  const wireMat = new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2 });
  highlightBox = new THREE.LineSegments(new THREE.WireframeGeometry(wireGeo), wireMat);
  highlightBox.visible = false;
  scene.add(highlightBox);

  // Small preview world so the scene isn't empty behind the menu; the real
  // world (with the chosen seed/size) is generated when the player hits Enter World.
  generateWorld('');

  setupEvents();
  animate();
}

// 5. PARTICLE EFFECTS
const particleGeo = new THREE.BoxGeometry(0.15, 0.15, 0.15); // shared by every break-particle, created once

function spawnBreakParticles(x, y, z, type) {
  const pMat = Array.isArray(blockMaterials[type]) ? blockMaterials[type][0] : blockMaterials[type];

  for (let i = 0; i < 12; i++) {
    const p = new THREE.Mesh(particleGeo, pMat);
    p.position.set(
      x + (Math.random() - 0.5) * 0.8,
      y + (Math.random() - 0.5) * 0.8,
      z + (Math.random() - 0.5) * 0.8
    );
    p.userData = {
      vx: (Math.random() - 0.5) * 0.12,
      vy: Math.random() * 0.15 + 0.05,
      vz: (Math.random() - 0.5) * 0.12,
      life: 1.0
    };
    scene.add(p);
    particles.push(p);
  }
}

function updateParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.position.x += p.userData.vx;
    p.position.y += p.userData.vy;
    p.position.z += p.userData.vz;
    p.userData.vy -= 0.008; // particle gravity
    p.userData.life -= 0.03;
    p.scale.multiplyScalar(0.95);

    if (p.userData.life <= 0) {
      scene.remove(p);
      particles.splice(i, 1);
    }
  }
}

// 6. INPUTS & HOTBAR
let moveF = false, moveB = false, moveL = false, moveR = false, jumpHeld = false;
let velocity = new THREE.Vector3();
let yVel = 0, isGrounded = false;
let walkTimer = 0;
const clock = new THREE.Clock();

// Movement tuning (all in units/second, framerate-independent)
const MOVE_SPEED = 4.3;      // top ground speed
const ACCEL_GROUND = 45;     // how fast you reach top speed on ground
const ACCEL_AIR = 10;        // limited air control, like Minecraft
const FRICTION_GROUND = 38;  // how fast you stop when you let go, on ground
const GRAVITY = 28;
const JUMP_SPEED = 8.6;

function approach(current, target, rate, delta) {
  const diff = target - current;
  const step = rate * delta;
  if (Math.abs(diff) <= step) return target;
  return current + Math.sign(diff) * step;
}

function setupEvents() {
  document.getElementById('start-game-btn').addEventListener('click', () => {
    const btn = document.getElementById('start-game-btn');
    setLoading(btn, true);
    // Let the spinner paint before the (synchronous) world build runs.
    setTimeout(() => {
      const seedField = document.getElementById('seed-input').value;
      const usedSeed = generateWorld(seedField);

      document.getElementById('seed-input').value = String(usedSeed);
      document.getElementById('seed-badge').textContent = 'Seed: ' + usedSeed;

      document.getElementById('menu-overlay').style.display = 'none';
      document.getElementById('crosshair').style.display = 'block';
      document.getElementById('hud-instructions').style.display = 'block';
      document.getElementById('hotbar-container').style.display = 'flex';
      document.getElementById('fps-counter').style.display = 'block';
      document.getElementById('seed-badge').style.display = 'block';

      setLoading(btn, false);
      controls.lock();
    }, 20);
  });

  document.getElementById('randomize-seed-btn').addEventListener('click', () => {
    document.getElementById('seed-input').value = String((Math.random() * 1e9) | 0);
  });

  controls.addEventListener('unlock', () => {
    document.getElementById('menu-overlay').style.display = 'flex';
    document.getElementById('crosshair').style.display = 'none';
  });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyW') moveF = true;
    if (e.code === 'KeyS') moveB = true;
    if (e.code === 'KeyA') moveL = true;
    if (e.code === 'KeyD') moveR = true;
    if (e.code === 'Space') { jumpHeld = true; e.preventDefault(); }
    if (e.key >= '1' && e.key <= '7') selectSlot(parseInt(e.key) - 1);
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'KeyW') moveF = false;
    if (e.code === 'KeyS') moveB = false;
    if (e.code === 'KeyA') moveL = false;
    if (e.code === 'KeyD') moveR = false;
    if (e.code === 'Space') jumpHeld = false;
  });

  document.addEventListener('wheel', (e) => {
    if (!controls.isLocked) return;
    if (e.deltaY > 0) selectSlot((activeBlockType) % 7);
    else selectSlot((activeBlockType - 2 + 7) % 7);
  });

  document.addEventListener('mousedown', (e) => {
    if (!controls.isLocked) return;
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hits = raycaster.intersectObjects(meshList);

    if (hits.length > 0) {
      const hit = hits[0];
      const type = hit.object.userData.type;
      const state = instanceState[type];
      const key = state && state.indexToKey.get(hit.instanceId);
      if (!key) return;
      const [bx, by, bz] = key.split(',').map(Number);

      if (e.button === 0) { // Left Click: Break
        spawnBreakParticles(bx, by, bz, type);
        setBlock(bx, by, bz, 0);
      } else if (e.button === 2) { // Right Click: Place
        const norm = hit.face.normal; // box instances are unrotated, so local normal == world normal
        const px = bx + Math.round(norm.x);
        const py = by + Math.round(norm.y);
        const pz = bz + Math.round(norm.z);

        // AABB Check against player position
        _placePlayerBox.setFromCenterAndSize(
          _placePlayerCenter.set(camera.position.x, camera.position.y - 0.7, camera.position.z),
          _placePlayerSize
        );
        _placeBlockBox.setFromCenterAndSize(
          _placeBlockCenter.set(px, py, pz),
          _placeBlockSize
        );

        if (!_placePlayerBox.intersectsBox(_placeBlockBox)) {
          setBlock(px, py, pz, activeBlockType);
        }
      }
    }
  });

  window.addEventListener('contextmenu', e => e.preventDefault());
}
// Reused scratch objects for the block-placement AABB check above, so a rapid burst of
// right-clicks doesn't allocate a fresh Box3/Vector3 pair on every single click.
const _placePlayerBox = new THREE.Box3();
const _placePlayerCenter = new THREE.Vector3();
const _placePlayerSize = new THREE.Vector3(0.6, 1.8, 0.6);
const _placeBlockBox = new THREE.Box3();
const _placeBlockCenter = new THREE.Vector3();
const _placeBlockSize = new THREE.Vector3(1, 1, 1);

function selectSlot(idx) {
  activeBlockType = idx + 1;
  const slots = document.querySelectorAll('.hotbar-slot');
  slots.forEach((s, i) => s.classList.toggle('active', i === idx));
}

// 7. PHYSICS & GAME LOOP
// Reused scratch objects for per-frame collision testing -- these used to be freshly
// allocated for the player AND for every candidate block on every axis check, every
// frame. Reusing them avoids that constant garbage-collection pressure, which is one
// of the more common causes of periodic micro-stutter in a loop like this one.
const _collPlayerBox = new THREE.Box3();
const _collPlayerCenter = new THREE.Vector3();
const _collPlayerSize = new THREE.Vector3(0.5, 1.7, 0.5);
const _collBlockBox = new THREE.Box3();
const _collBlockCenter = new THREE.Vector3();
const _collBlockSize = new THREE.Vector3(1, 1, 1);

function checkCollision(pos) {
  _collPlayerCenter.set(pos.x, pos.y - 0.7, pos.z);
  _collPlayerBox.setFromCenterAndSize(_collPlayerCenter, _collPlayerSize);

  const minX = Math.floor(pos.x - 1), maxX = Math.ceil(pos.x + 1);
  const minY = Math.floor(pos.y - 2), maxY = Math.ceil(pos.y + 1);
  const minZ = Math.floor(pos.z - 1), maxZ = Math.ceil(pos.z + 1);

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        if (worldBlocks[getBlockKey(x, y, z)]) {
          _collBlockCenter.set(x, y, z);
          _collBlockBox.setFromCenterAndSize(_collBlockCenter, _collBlockSize);
          if (_collPlayerBox.intersectsBox(_collBlockBox)) return true;
        }
      }
    }
  }
  return false;
}

function animate() {
  requestAnimationFrame(animate);

  // FPS counter
  const now = performance.now();
  const dt = now - lastFrameTime;
  lastFrameTime = now;
  fpsAccum += dt; fpsFrames++;
  if (fpsAccum >= 500) {
    const fps = Math.round((fpsFrames * 1000) / fpsAccum);
    document.getElementById('fps-counter').textContent = 'FPS: ' + fps;
    fpsAccum = 0; fpsFrames = 0;
  }

  // Infinite-world streaming: cheap early-out unless the player crossed into a new chunk
  refreshChunkStreaming();
  processChunkQueue();

  // Clamp delta so tab-switches / hitches don't cause a huge teleport-y step
  const delta = Math.min(clock.getDelta(), 0.1);

  if (controls.isLocked) {
    const hasInput = moveF || moveB || moveL || moveR;

    // Build wish direction in world space from camera facing
    const dir = new THREE.Vector3();
    if (moveF) dir.z -= 1;
    if (moveB) dir.z += 1;
    if (moveL) dir.x -= 1;
    if (moveR) dir.x += 1;
    if (hasInput) dir.normalize();

    let targetX = 0, targetZ = 0;
    if (hasInput) {
      const moveDir = dir.applyQuaternion(camera.quaternion);
      moveDir.y = 0;
      moveDir.normalize();
      targetX = moveDir.x * MOVE_SPEED;
      targetZ = moveDir.z * MOVE_SPEED;
    }

    // Accelerate toward target speed on input, decelerate to a hard stop
    // when there's none (ground), or keep momentum with limited control (air)
    const accelRate = isGrounded ? ACCEL_GROUND : ACCEL_AIR;
    const stopRate = isGrounded ? FRICTION_GROUND : 0;
    velocity.x = approach(velocity.x, targetX, hasInput ? accelRate : stopRate, delta);
    velocity.z = approach(velocity.z, targetZ, hasInput ? accelRate : stopRate, delta);

    // Apply X Move & Collide
    camera.position.x += velocity.x * delta;
    if (checkCollision(camera.position)) { camera.position.x -= velocity.x * delta; velocity.x = 0; }

    // Apply Z Move & Collide
    camera.position.z += velocity.z * delta;
    if (checkCollision(camera.position)) { camera.position.z -= velocity.z * delta; velocity.z = 0; }

    // World border: hard stop at +-10,000,000 blocks
    camera.position.x = Math.max(-WORLD_BORDER + 1, Math.min(WORLD_BORDER - 1, camera.position.x));
    camera.position.z = Math.max(-WORLD_BORDER + 1, Math.min(WORLD_BORDER - 1, camera.position.z));

    // Gravity & Y Physics
    yVel -= GRAVITY * delta;
    camera.position.y += yVel * delta;

    if (checkCollision(camera.position)) {
      camera.position.y -= yVel * delta;
      if (yVel < 0) { isGrounded = true; }
      yVel = 0;
    } else {
      isGrounded = false;
    }

    if (jumpHeld && isGrounded) {
      yVel = JUMP_SPEED;
      isGrounded = false;
    }

    // Raycast Outline Target
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hits = raycaster.intersectObjects(meshList);
    if (hits.length > 0) {
      const hit = hits[0];
      const type = hit.object.userData.type;
      const state = instanceState[type];
      const key = state && state.indexToKey.get(hit.instanceId);
      if (key) {
        const [bx, by, bz] = key.split(',').map(Number);
        highlightBox.position.set(bx, by, bz);
        highlightBox.visible = true;
      } else {
        highlightBox.visible = false;
      }
    } else {
      highlightBox.visible = false;
    }

    updateParticles();
  }

  renderer.render(scene, camera);
}

window.onload = init;
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
