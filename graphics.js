/* =========================================================================================
   KITABLOX GRAPHICS MODULE
   Procedural pixel-art block textures (generated once, cheaply, on load) and the
   THREE.Material sets each block type uses. Depends on THREE being loaded already.
   Everything here runs once at parse time -- no per-frame cost -- so it isn't a lag
   source, but it's split out so texture/material tweaks live in one obvious place.
   ========================================================================================= */

// PROCEDURAL PIXEL TEXTURE GENERATOR WITH DYNAMIC FACE SHADING
function createTexture(type) {
  const canvas = document.createElement('canvas');
  canvas.width = 16; canvas.height = 16;
  const ctx = canvas.getContext('2d');

  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 16; y++) {
      let n = (Math.random() - 0.5) * 18;
      if (type === 'grass_top') ctx.fillStyle = `rgb(${80 + n}, ${185 + n}, ${50 + n})`;
      else if (type === 'dirt') ctx.fillStyle = `rgb(${120 + n}, ${80 + n}, ${45 + n})`;
      else if (type === 'grass_side') ctx.fillStyle = y < 4 ? `rgb(${80 + n}, ${185 + n}, ${50 + n})` : `rgb(${120 + n}, ${80 + n}, ${45 + n})`;
      else if (type === 'stone') ctx.fillStyle = `rgb(${110 + n}, ${115 + n}, ${120 + n})`;
      else if (type === 'wood_top') ctx.fillStyle = `rgb(${140 + n}, ${100 + n}, ${55 + n})`;
      else if (type === 'wood_side') ctx.fillStyle = `rgb(${90 + n}, ${60 + n}, ${30 + n})`;
      else if (type === 'leaves') ctx.fillStyle = `rgb(${40 + n}, ${140 + n}, ${40 + n})`;
      else if (type === 'sand') ctx.fillStyle = `rgb(${215 + n}, ${195 + n}, ${125 + n})`;
      else if (type === 'glass') {
        ctx.fillStyle = (x === 0 || x === 15 || y === 0 || y === 15) ? 'rgba(255,255,255,0.7)' : 'rgba(200,230,255,0.15)';
      }
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  return tex;
}

const texMap = {
  grassTop: createTexture('grass_top'),
  grassSide: createTexture('grass_side'),
  dirt: createTexture('dirt'),
  stone: createTexture('stone'),
  woodTop: createTexture('wood_top'),
  woodSide: createTexture('wood_side'),
  leaves: createTexture('leaves'),
  sand: createTexture('sand'),
  glass: createTexture('glass')
};

function mat(tex, transparent = false, opacity = 1.0) {
  return new THREE.MeshLambertMaterial({ map: tex, transparent, opacity });
}

// Block type -> material (or per-face material array: [+x,-x,+y,-y,+z,-z])
const blockMaterials = {
  1: [mat(texMap.grassSide), mat(texMap.grassSide), mat(texMap.grassTop), mat(texMap.dirt), mat(texMap.grassSide), mat(texMap.grassSide)],
  2: mat(texMap.dirt),
  3: mat(texMap.stone),
  4: [mat(texMap.woodSide), mat(texMap.woodSide), mat(texMap.woodTop), mat(texMap.woodTop), mat(texMap.woodSide), mat(texMap.woodSide)],
  5: mat(texMap.leaves, true, 0.9),
  6: mat(texMap.sand),
  7: mat(texMap.glass, true, 0.4)
};
