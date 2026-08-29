/* =========================================================================================
   KITABLOX ENGINE MODULE
   Scene/camera/renderer setup, input (keyboard+mouse on desktop, touch on mobile),
   hotbar selection, break/place particles, player physics + collision, camera
   perspective switching, and the main requestAnimationFrame loop.

   Depends on THREE, PointerLockControls, graphics.js (blockMaterials) and world.js
   (worldBlocks, setBlock, generateWorld, refreshChunkStreaming, processChunkQueue,
   CHUNK_SIZE, RENDER_DISTANCE).

   KEY ARCHITECTURE NOTE -- playerPos vs. camera:
   `playerPos` (a THREE.Vector3) is the single source of truth for where the player
   actually is -- physics, collision, and chunk streaming all read/write it. The THREE
   `camera` object used for rendering is a separate thing: every frame,
   updateCameraTransform() points it wherever the active perspective mode wants (at
   playerPos for first-person, behind/in front of it for third-person). This split is
   what makes third-person possible without breaking collision or world streaming, which
   need the player's *actual* position, not wherever the camera happens to be floating.

   Similarly, `lookRig` (a bare THREE.Object3D) is what PointerLockControls actually
   rotates via mouse-look -- not the camera. That keeps "which way the player is facing"
   independent of "what the camera is currently doing for a third-person shot", so
   flipping the camera around in front-facing selfie mode never corrupts mouse-look.

   PERFORMANCE NOTES:
   - checkCollision() and the block-placement check reuse pooled THREE.Box3/Vector3
     objects instead of allocating new ones every block/frame, avoiding GC-driven stutter.
   - The break-particle box geometry is created once and shared by every particle.
   - Fog density and the camera's far plane are derived from RENDER_DISTANCE so the
     world fades out right around where chunks stream in/out.
   - All mobile touch-event listeners are skipped entirely on desktop (isMobileDevice
     check up front), so they add zero overhead there.
   ========================================================================================= */

// ---------- Mobile detection (automatic; drives which controls are shown) ----------
function detectMobileDevice() {
  try {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
  } catch (e) { /* ignore */ }
  return /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent || '');
}
const isMobileDevice = detectMobileDevice();
document.body.classList.toggle('is-mobile', isMobileDevice);

// 4. ENGINE & SCENE SETUP
let scene, camera, renderer, controls, raycaster, highlightBox;
let lookRig = new THREE.Object3D();     // what mouse-look / touch-look actually rotates
let playerPos = new THREE.Vector3();    // authoritative player position (physics/streaming)
let playerAvatar;                       // simple visible body, shown in 3rd-person modes
let gameActive = false;                 // true whenever the player is actively in-world
let particles = [];
let activeBlockType = 1;
let lastFrameTime = performance.now();
let fpsAccum = 0, fpsFrames = 0;
const ORIGIN_VEC2 = new THREE.Vector2(0, 0);

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
  renderer.domElement.style.touchAction = 'none'; // stop the browser from scrolling/zooming on touch
  document.body.appendChild(renderer.domElement);

  // Sun & Hemisphere Lighting
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444455, 0.7);
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
  dirLight.position.set(40, 60, 20);
  scene.add(dirLight);

  // PointerLockControls drives `lookRig`, NOT `camera` -- see architecture note above.
  controls = new THREE.PointerLockControls(lookRig, document.body);
  raycaster = new THREE.Raycaster();
  raycaster.far = 7;

  // Selection Wireframe Highlight
  const wireGeo = new THREE.BoxGeometry(1.005, 1.005, 1.005);
  const wireMat = new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2 });
  highlightBox = new THREE.LineSegments(new THREE.WireframeGeometry(wireGeo), wireMat);
  highlightBox.visible = false;
  scene.add(highlightBox);

  playerAvatar = createPlayerAvatar();
  scene.add(playerAvatar);

  // Small preview world so the scene isn't empty behind the menu; the real
  // world (with the chosen seed/size) is generated when the player hits Enter World.
  generateWorld('');
  updateCameraTransform();

  setupEvents();
  setupMobileControls();
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
const joystickInput = { x: 0, z: 0 }; // analog mobile joystick contribution, -1..1 each axis

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

// ---------- Shared break/place logic (used by desktop mouse AND mobile buttons) ----------
function performBreak() {
  raycaster.setFromCamera(ORIGIN_VEC2, camera);
  const hits = raycaster.intersectObjects(meshList);
  if (!hits.length) return;
  const hit = hits[0];
  const type = hit.object.userData.type;
  const state = instanceState[type];
  const key = state && state.indexToKey.get(hit.instanceId);
  if (!key) return;
  const [bx, by, bz] = key.split(',').map(Number);
  spawnBreakParticles(bx, by, bz, type);
  setBlock(bx, by, bz, 0);
}

function performPlace() {
  raycaster.setFromCamera(ORIGIN_VEC2, camera);
  const hits = raycaster.intersectObjects(meshList);
  if (!hits.length) return;
  const hit = hits[0];
  const type = hit.object.userData.type;
  const state = instanceState[type];
  const key = state && state.indexToKey.get(hit.instanceId);
  if (!key) return;
  const [bx, by, bz] = key.split(',').map(Number);
  const norm = hit.face.normal; // box instances are unrotated, so local normal == world normal
  const px = bx + Math.round(norm.x);
  const py = by + Math.round(norm.y);
  const pz = bz + Math.round(norm.z);

  // AABB check against the player's ACTUAL position (not the camera, which may be
  // offset behind/in front of the player in third-person modes).
  _placePlayerBox.setFromCenterAndSize(
    _placePlayerCenter.set(playerPos.x, playerPos.y - 0.7, playerPos.z),
    _placePlayerSize
  );
  _placeBlockBox.setFromCenterAndSize(_placeBlockCenter.set(px, py, pz), _placeBlockSize);

  if (!_placePlayerBox.intersectsBox(_placeBlockBox)) {
    setBlock(px, py, pz, activeBlockType);
  }
}
// Reused scratch objects for the block-placement AABB check above, so a rapid burst of
// clicks/taps doesn't allocate a fresh Box3/Vector3 pair every time.
const _placePlayerBox = new THREE.Box3();
const _placePlayerCenter = new THREE.Vector3();
const _placePlayerSize = new THREE.Vector3(0.6, 1.8, 0.6);
const _placeBlockBox = new THREE.Box3();
const _placeBlockCenter = new THREE.Vector3();
const _placeBlockSize = new THREE.Vector3(1, 1, 1);

// ---------- Pause / resume ----------
function handleUnlocked() {
  gameActive = false;
  document.getElementById('menu-overlay').style.display = 'flex';
  document.getElementById('crosshair').style.display = 'none';
  document.getElementById('mobile-controls').style.display = 'none';
  document.getElementById('mobile-top-buttons').style.display = 'none';
}

// Mobile's settings button (and, on desktop, anything that wants to programmatically
// pause) route through here -- it's the "ESC equivalent" for devices with no ESC key.
function pauseToMenu() {
  if (!isMobileDevice && controls.isLocked) {
    controls.unlock(); // fires the 'unlock' event above, which calls handleUnlocked()
  } else {
    handleUnlocked();
  }
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
      document.getElementById('hud-instructions').style.display = isMobileDevice ? 'none' : 'block';
      document.getElementById('hotbar-container').style.display = 'flex';
      document.getElementById('fps-counter').style.display = 'block';
      document.getElementById('seed-badge').style.display = 'block';

      setLoading(btn, false);

      if (isMobileDevice) {
        // No pointer-lock on touch devices -- just start the session directly and
        // show the on-screen joystick/buttons.
        gameActive = true;
        document.getElementById('mobile-controls').style.display = 'flex';
        document.getElementById('mobile-top-buttons').style.display = 'flex';
      } else {
        controls.lock();
      }
    }, 20);
  });

  document.getElementById('randomize-seed-btn').addEventListener('click', () => {
    document.getElementById('seed-input').value = String((Math.random() * 1e9) | 0);
  });

  controls.addEventListener('lock', () => { gameActive = true; });
  controls.addEventListener('unlock', handleUnlocked);

  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyW') moveF = true;
    if (e.code === 'KeyS') moveB = true;
    if (e.code === 'KeyA') moveL = true;
    if (e.code === 'KeyD') moveR = true;
    if (e.code === 'Space') { jumpHeld = true; e.preventDefault(); }
    if (e.key >= '1' && e.key <= '7') selectSlot(parseInt(e.key) - 1);
    // Alt and F5 both cycle the camera perspective (1st person -> 3rd person behind
    // -> 3rd person front/selfie). Only intercepted while actually playing, so F5
    // still refreshes the page as normal from the menu.
    if (e.code === 'AltLeft' || e.code === 'AltRight' || e.code === 'F5') {
      if (gameActive) {
        e.preventDefault();
        cyclePerspective();
      }
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'KeyW') moveF = false;
    if (e.code === 'KeyS') moveB = false;
    if (e.code === 'KeyA') moveL = false;
    if (e.code === 'KeyD') moveR = false;
    if (e.code === 'Space') jumpHeld = false;
  });

  document.addEventListener('wheel', (e) => {
    if (!gameActive || isMobileDevice) return;
    if (e.deltaY > 0) selectSlot((activeBlockType) % 7);
    else selectSlot((activeBlockType - 2 + 7) % 7);
  });

  document.addEventListener('mousedown', (e) => {
    if (isMobileDevice || !gameActive) return;
    if (e.button === 0) performBreak();       // Left click: break
    else if (e.button === 2) performPlace();  // Right click: place
  });

  window.addEventListener('contextmenu', e => e.preventDefault());

  // Hotbar is tappable/clickable on both desktop and mobile (in the original this was
  // keyboard/scroll-wheel only, which doesn't work at all without a keyboard).
  document.querySelectorAll('.hotbar-slot').forEach((slot, i) => {
    slot.addEventListener('click', () => selectSlot(i));
  });
}

function selectSlot(idx) {
  activeBlockType = idx + 1;
  const slots = document.querySelectorAll('.hotbar-slot');
  slots.forEach((s, i) => s.classList.toggle('active', i === idx));
}

// 7. PHYSICS & GAME LOOP
// Reused scratch objects for per-frame collision testing -- these used to be freshly
// allocated for the player AND for every candidate block on every axis check, every
// frame. Reusing them avoids constant garbage-collection pressure, a common cause of
// periodic micro-stutter in a loop like this one.
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

// ---------- Camera perspective (1st person / 3rd person behind / 3rd person front) ----------
let perspectiveMode = 0;
const PERSPECTIVE_COUNT = 3;
const THIRD_PERSON_DISTANCE = 4.5;
const THIRD_PERSON_HEIGHT = 0.6;
const FRONT_PERSON_DISTANCE = 2.6;
const _camForwardVec = new THREE.Vector3();
const _camDesired = new THREE.Vector3();
const _camClampDir = new THREE.Vector3();
const cameraClampRaycaster = new THREE.Raycaster();

function cyclePerspective() {
  perspectiveMode = (perspectiveMode + 1) % PERSPECTIVE_COUNT;
  playerAvatar.visible = perspectiveMode !== 0;
}

// Keeps the third-person camera from clipping through terrain behind/in front of the
// player: casts from the player out toward the desired camera spot and, if it hits
// something, pulls the camera in just short of that hit.
function clampCameraToTerrain(origin, desired) {
  _camClampDir.subVectors(desired, origin);
  const dist = _camClampDir.length();
  if (dist < 0.05) return desired;
  _camClampDir.normalize();
  cameraClampRaycaster.set(origin, _camClampDir);
  cameraClampRaycaster.near = 0.1;
  cameraClampRaycaster.far = dist;
  const hits = cameraClampRaycaster.intersectObjects(meshList);
  if (hits.length > 0) {
    const safeDist = Math.max(hits[0].distance - 0.35, 0.35);
    return origin.clone().addScaledVector(_camClampDir, safeDist);
  }
  return desired;
}

// Points the real render camera wherever the active perspective mode wants it, based
// on the authoritative playerPos + lookRig orientation. Safe to call every frame
// (and even while paused) since it's cheap and idempotent.
function updateCameraTransform() {
  if (perspectiveMode === 0) {
    camera.position.copy(playerPos);
    camera.quaternion.copy(lookRig.quaternion);
  } else if (perspectiveMode === 1) {
    _camForwardVec.set(0, 0, -1).applyQuaternion(lookRig.quaternion);
    _camDesired.copy(playerPos).addScaledVector(_camForwardVec, -THIRD_PERSON_DISTANCE);
    _camDesired.y += THIRD_PERSON_HEIGHT;
    camera.position.copy(clampCameraToTerrain(playerPos, _camDesired));
    camera.quaternion.copy(lookRig.quaternion);
  } else {
    _camForwardVec.set(0, 0, -1).applyQuaternion(lookRig.quaternion);
    _camDesired.copy(playerPos).addScaledVector(_camForwardVec, FRONT_PERSON_DISTANCE);
    _camDesired.y += THIRD_PERSON_HEIGHT;
    camera.position.copy(clampCameraToTerrain(playerPos, _camDesired));
    camera.lookAt(playerPos.x, playerPos.y - 0.2, playerPos.z);
  }
  camera.updateMatrixWorld();
}

// ---------- Simple visible player body (only shown in 3rd-person modes) ----------
function createPlayerAvatar() {
  const group = new THREE.Group();
  const skinMat = new THREE.MeshLambertMaterial({ color: 0xe0ac69 });
  const shirtMat = new THREE.MeshLambertMaterial({ color: 0x4ade80 });
  const pantsMat = new THREE.MeshLambertMaterial({ color: 0x334155 });

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.45), skinMat);
  head.position.y = 1.55;
  group.add(head);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.28), shirtMat);
  torso.position.y = 1.0;
  group.add(torso);

  const legGeo = new THREE.BoxGeometry(0.22, 0.7, 0.26);
  const legL = new THREE.Mesh(legGeo, pantsMat);
  legL.position.set(-0.13, 0.35, 0);
  group.add(legL);
  const legR = new THREE.Mesh(legGeo, pantsMat);
  legR.position.set(0.13, 0.35, 0);
  group.add(legR);

  const armGeo = new THREE.BoxGeometry(0.2, 0.65, 0.22);
  const armL = new THREE.Mesh(armGeo, shirtMat);
  armL.position.set(-0.36, 1.0, 0);
  group.add(armL);
  const armR = new THREE.Mesh(armGeo, shirtMat);
  armR.position.set(0.36, 1.0, 0);
  group.add(armR);

  group.visible = false; // starts hidden -- first-person shows nothing, as before
  return group;
}

const _avatarEuler = new THREE.Euler(0, 0, 0, 'YXZ');
function updatePlayerAvatar() {
  playerAvatar.position.set(playerPos.x, playerPos.y - 1.6, playerPos.z);
  _avatarEuler.setFromQuaternion(lookRig.quaternion);
  playerAvatar.rotation.y = _avatarEuler.y;
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

  if (gameActive) {
    const hasKeyInput = moveF || moveB || moveL || moveR;

    // Build wish direction in world space from look direction (keyboard is digital,
    // the mobile joystick is analog -- both simply add into the same vector).
    const dir = new THREE.Vector3();
    if (moveF) dir.z -= 1;
    if (moveB) dir.z += 1;
    if (moveL) dir.x -= 1;
    if (moveR) dir.x += 1;
    dir.x += joystickInput.x;
    dir.z += joystickInput.z;
    const hasInput = hasKeyInput || dir.lengthSq() > 0.0001;
    if (dir.lengthSq() > 1) dir.normalize();

    let targetX = 0, targetZ = 0;
    if (hasInput) {
      const moveDir = dir.applyQuaternion(lookRig.quaternion);
      moveDir.y = 0;
      if (moveDir.lengthSq() > 0.0001) moveDir.normalize();
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
    playerPos.x += velocity.x * delta;
    if (checkCollision(playerPos)) { playerPos.x -= velocity.x * delta; velocity.x = 0; }

    // Apply Z Move & Collide
    playerPos.z += velocity.z * delta;
    if (checkCollision(playerPos)) { playerPos.z -= velocity.z * delta; velocity.z = 0; }

    // World border: hard stop at +-10,000,000 blocks
    playerPos.x = Math.max(-WORLD_BORDER + 1, Math.min(WORLD_BORDER - 1, playerPos.x));
    playerPos.z = Math.max(-WORLD_BORDER + 1, Math.min(WORLD_BORDER - 1, playerPos.z));

    // Gravity & Y Physics
    yVel -= GRAVITY * delta;
    playerPos.y += yVel * delta;

    if (checkCollision(playerPos)) {
      playerPos.y -= yVel * delta;
      if (yVel < 0) { isGrounded = true; }
      yVel = 0;
    } else {
      isGrounded = false;
    }

    if (jumpHeld && isGrounded) {
      yVel = JUMP_SPEED;
      isGrounded = false;
    }
  }

  updateCameraTransform();
  updatePlayerAvatar();

  if (gameActive) {
    // Raycast Outline Target
    raycaster.setFromCamera(ORIGIN_VEC2, camera);
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

// ================================================================================
// 8. MOBILE CONTROLS (Bloxd-style virtual joystick + touch-look + action buttons)
// Skipped entirely on desktop (isMobileDevice is checked once, up front) so it adds
// zero listeners/overhead there.
// ================================================================================
let joystickTouchId = null;
let lookTouchId = null;
let lookLastX = 0, lookLastY = 0;
const JOYSTICK_MAX_RADIUS = 42; // px
const TOUCH_LOOK_SENSITIVITY = 0.0028;
const _mobileLookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const PI_2 = Math.PI / 2;

// Rotates lookRig directly from a touch-drag delta, mirroring the math
// PointerLockControls uses for mouse movement (kept in sync manually since touch
// events never fire PointerLockControls' own mousemove listener).
function applyLookDelta(dx, dy) {
  _mobileLookEuler.setFromQuaternion(lookRig.quaternion);
  _mobileLookEuler.y -= dx * TOUCH_LOOK_SENSITIVITY;
  _mobileLookEuler.x -= dy * TOUCH_LOOK_SENSITIVITY;
  _mobileLookEuler.x = Math.max(-PI_2, Math.min(PI_2, _mobileLookEuler.x));
  lookRig.quaternion.setFromEuler(_mobileLookEuler);
}

function isMobileControlElement(target) {
  return !!(target && target.closest &&
    target.closest('.mobile-btn, .mobile-icon-btn, #joystick-zone, .hotbar-slot'));
}

function updateJoystickKnob(dx, dy) {
  const knob = document.getElementById('joystick-knob');
  if (knob) knob.style.transform = `translate(${dx}px, ${dy}px)`;
}

function setupMobileControls() {
  if (!isMobileDevice) return;

  const joystickZone = document.getElementById('joystick-zone');

  document.addEventListener('touchstart', (e) => {
    if (!gameActive) return;
    for (const touch of e.changedTouches) {
      const withinJoystick = joystickZone && joystickZone.contains(touch.target);
      if (withinJoystick && joystickTouchId === null) {
        joystickTouchId = touch.identifier;
        e.preventDefault();
      } else if (!withinJoystick && !isMobileControlElement(touch.target) && lookTouchId === null) {
        lookTouchId = touch.identifier;
        lookLastX = touch.clientX;
        lookLastY = touch.clientY;
        e.preventDefault();
      }
    }
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (!gameActive) return;
    for (const touch of e.changedTouches) {
      if (touch.identifier === joystickTouchId) {
        const rect = joystickZone.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        let dx = touch.clientX - cx, dy = touch.clientY - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > JOYSTICK_MAX_RADIUS) {
          const scale = JOYSTICK_MAX_RADIUS / dist;
          dx *= scale; dy *= scale;
        }
        joystickInput.x = dx / JOYSTICK_MAX_RADIUS;
        joystickInput.z = dy / JOYSTICK_MAX_RADIUS;
        updateJoystickKnob(dx, dy);
        e.preventDefault();
      } else if (touch.identifier === lookTouchId) {
        const dx = touch.clientX - lookLastX;
        const dy = touch.clientY - lookLastY;
        lookLastX = touch.clientX;
        lookLastY = touch.clientY;
        applyLookDelta(dx, dy);
        e.preventDefault();
      }
    }
  }, { passive: false });

  function endTouch(e) {
    for (const touch of e.changedTouches) {
      if (touch.identifier === joystickTouchId) {
        joystickTouchId = null;
        joystickInput.x = 0; joystickInput.z = 0;
        updateJoystickKnob(0, 0);
      }
      if (touch.identifier === lookTouchId) {
        lookTouchId = null;
      }
    }
  }
  document.addEventListener('touchend', endTouch, { passive: false });
  document.addEventListener('touchcancel', endTouch, { passive: false });

  // Wires a button's tap-down/tap-up to callbacks, stopping the touch from also
  // being picked up by the look-drag handler above.
  const bindButton = (id, onStart, onEnd) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (onStart) onStart();
    }, { passive: false });
    if (onEnd) {
      el.addEventListener('touchend', (e) => {
        e.preventDefault(); e.stopPropagation();
        onEnd();
      }, { passive: false });
      el.addEventListener('touchcancel', (e) => {
        e.preventDefault(); e.stopPropagation();
        onEnd();
      }, { passive: false });
    }
  };

  bindButton('jump-btn', () => { jumpHeld = true; }, () => { jumpHeld = false; });
  bindButton('break-btn', () => performBreak());
  bindButton('place-btn', () => performPlace());
  bindButton('perspective-btn', () => cyclePerspective());
  bindButton('settings-btn', () => pauseToMenu());

  document.querySelectorAll('.hotbar-slot').forEach((slot, i) => {
    slot.addEventListener('touchstart', (e) => {
      e.preventDefault(); e.stopPropagation();
      selectSlot(i);
    }, { passive: false });
  });
}

window.onload = init;
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
