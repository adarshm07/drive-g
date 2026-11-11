import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  WORLD, BOUNDS, TERRAIN, ROADS, LANDMARKS, PADDIES, BEACH_ENTRY, SURF,
  samplePath, heightAt, distToRoad, waterDist, surfaceAt, onCrossingRoad,
} from '/shared/world.js';
import { makeLabel } from './cars.js';
import { coconutPalm, arecaPalm, palmMaterial, lodInstances } from './palms.js';
import { SHOP_TYPES, KEEPERS, makeKeeper } from './shops.js';
import { buildRailway } from './railway.js';
import { makeWater } from './water.js';
import { QUALITY } from './quality.js';

const L = (color, o = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...o });
const V = (x, y, z) => new THREE.Vector3(x, y, z);

function rng32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function box(w, h, d, m, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  return mesh;
}
function cyl(rt, rb, h, m, x, y, z, seg = 8) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  mesh.position.set(x, y, z);
  return mesh;
}
// Four-sided sloped (hip) roof, w x d at the eaves, h tall. y is the eave height.
const HIP = new THREE.ConeGeometry(1, 1, 4).rotateY(Math.PI / 4);
function hip(w, h, d, m, x, y, z) {
  const mesh = new THREE.Mesh(HIP, m);
  mesh.scale.set(w / Math.SQRT2, h, d / Math.SQRT2);
  mesh.position.set(x, y + h / 2, z);
  return mesh;
}

/** Turns (x, z) in a model's local frame into world coordinates, for colliders. */
const local = (bx, bz, rot) => (x, z) => [bx + x * Math.cos(rot) + z * Math.sin(rot), bz - x * Math.sin(rot) + z * Math.cos(rot)];

// Many small static meshes are merged per material, so the whole town is a handful of draw calls.
class Statics {
  constructor() { this.byMat = new Map(); }
  add(obj) {
    obj.updateMatrixWorld(true);
    obj.traverse((m) => {
      if (!m.isMesh) return;
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      g.deleteAttribute('uv');
      g.applyMatrix4(m.matrixWorld);
      if (!this.byMat.has(m.material)) this.byMat.set(m.material, []);
      this.byMat.get(m.material).push(g);
    });
  }
  // merged per material and per 240-unit tile, so whole tiles off screen are skipped
  flush(scene) {
    for (const [mat, list] of this.byMat) {
      const tiles = new Map();
      for (const g of list) {
        g.computeBoundingSphere();
        const c = g.boundingSphere.center, k = Math.floor(c.x / 240) * 1000 + Math.floor(c.z / 240);
        if (!tiles.has(k)) tiles.set(k, []);
        tiles.get(k).push(g);
      }
      for (const group of tiles.values()) for (let i = 0; i < group.length; i += 4000) scene.add(new THREE.Mesh(mergeGeometries(group.slice(i, i + 4000)), mat));
    }
    this.byMat.clear();
  }
}

const roadY = (x, z) => Math.max(heightAt(x, z), 0.15);

// Smooth 0..1 noise with features about `scale` units across. Gives the land its patches and groves.
const hash2 = (i, j) => { const v = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return v - Math.floor(v); };
function vnoise(x, z, scale) {
  const fx = x / scale, fz = z / scale, i = Math.floor(fx), j = Math.floor(fz);
  const u = fx - i, v = fz - j, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  return (hash2(i, j) * (1 - su) + hash2(i + 1, j) * su) * (1 - sv) + (hash2(i, j + 1) * (1 - su) + hash2(i + 1, j + 1) * su) * sv;
}
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const townness = (x, z) => 1 - sstep(90, 200, Math.hypot(x + 500, z - 170));

// Fine grain for the ground: a small tiling noise texture that the terrain colours are multiplied by,
// so grass, laterite and sand do not look like plastic up close. Light (0.84..1) so colours hold.
function groundDetail(repeatX, repeatZ) {
  const n = 128, c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d'), img = ctx.createImageData(n, n), r = rng32(9917);
  const v = new Float32Array(n * n);
  for (let i = 0; i < v.length; i++) v[i] = r();
  for (let pass = 0; pass < 2; pass++) {               // soften into small clumps, wrapping at the edges
    const o = Float32Array.from(v);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += o[((y + dy + n) % n) * n + ((x + dx + n) % n)];
      v[y * n + x] = s / 9 * 0.7 + r() * 0.3;
    }
  }
  for (let i = 0; i < v.length; i++) {
    const g = Math.round(255 * (0.84 + 0.16 * Math.min(1, Math.max(0, (v[i] - 0.3) * 2.5))));
    img.data.set([g, g, g, 255], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatZ);
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Contact shading: darken the ground a little around the base of buildings, trees and walls, as
// the sky light would be blocked there. Done once, on the terrain's vertex colours.
function groundContactShade(geo, colliders) {
  if (!geo) return;
  const grid = new Map(), CELL = 10, key = (i, j) => i * 100003 + j;
  for (const c of colliders) {
    const k = key(Math.floor(c.x / CELL), Math.floor(c.z / CELL));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(c);
  }
  const p = geo.attributes.position, col = geo.attributes.color;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    let occ = 0;
    for (let a = ci - 1; a <= ci + 1; a++) for (let b = cj - 1; b <= cj + 1; b++) {
      const list = grid.get(key(a, b));
      if (list) for (const c of list) {
        const d = Math.hypot(c.x - x, c.z - z) - c.r;
        if (d < 3.5) occ += (1 - Math.max(0, d) / 3.5) * Math.min(1, c.r / 2 + 0.25);
      }
    }
    if (!occ) continue;
    const k = 1 - 0.32 * Math.min(1, occ);
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  col.needsUpdate = true;
}

export function buildWorld(scene) {
  const rng = rng32(20261110);
  const colliders = [];
  const animated = [];
  const statics = new Statics();
  let terrainGeo = null; // kept for the contact shading at the end
  const shops = [];   // interactive shops: { x, z, type, keeper, mesh }
  const B = BOUNDS;
  // sky, sun, fog and shadows are set up in look.js

  // ----- terrain: heights and colours come from the OpenStreetMap-derived raster -----
  {
    const W = B.x1 - B.x0, D = B.z1 - B.z0, cell = 5;
    const geo = new THREE.PlaneGeometry(W, D, Math.round(W / cell), Math.round(D / cell)).rotateX(-Math.PI / 2);
    geo.translate((B.x0 + B.x1) / 2, 0, (B.z0 + B.z1) / 2);
    const p = geo.attributes.position;
    const col = new Float32Array(p.count * 3);
    const c = new THREE.Color();
    const mud = new THREE.Color(0x9c8c64), lush = new THREE.Color(0x6db552), dry = new THREE.Color(0xbdb964), deep = new THREE.Color(0x478a44);
    const laterite = new THREE.Color(0xb06a45), wet = new THREE.Color(0x4f9a63), urban = new THREE.Color(0xc2b79b), scrub = new THREE.Color(0x8aa35a);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), h = heightAt(x, z), s = surfaceAt(x, z);
      p.setY(i, h);
      if (h < WORLD.water + 0.15) c.copy(mud);
      else if (s === SURF.drivein) c.set(0xd9c58e);         // hard, damp sand you can drive on
      else if (s === SURF.sand) c.set(0xecdcab);
      else if (s === SURF.paddy) c.set(0x9bd65c);
      else {
        // the land changes from place to place: lush and dry grass, dark groves, red laterite on the
        // hills, wet green along the rivers, scrub behind the beaches and bare ground in town
        const n1 = vnoise(x, z, 170), n2 = vnoise(x + 999, z - 555, 65), sd = waterDist(x, z);
        c.copy(lush).lerp(dry, sstep(0.35, 0.7, n1)).lerp(deep, sstep(0.45, 0.75, n2) * 0.8);
        c.lerp(laterite, Math.min(0.9, sstep(2.6, 6, h) * (0.4 + n2) + sstep(0.66, 0.88, n1) * 0.8));
        c.lerp(wet, (1 - sstep(0, 26, sd)) * 0.75);
        if (x < -150 && sd < 60) c.lerp(scrub, (1 - sstep(10, 60, sd)) * 0.5);
        c.lerp(urban, townness(x, z) * 0.6);
      }
      const n = Math.abs((Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1);
      c.offsetHSL(0, 0, (n - 0.5) * 0.045);
      col.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, L(0xffffff, { vertexColors: true, map: QUALITY.groundDetail ? groundDetail(W / 7, D / 7) : null }));
    ground.userData.shadow = 'receive';
    scene.add(ground);
    terrainGeo = geo;

    scene.add(makeWater());
    // the world beyond the map edge: plain land so the horizon is not a cliff
    const outer = L(0x6aa84f);
    const ring = [[B.x1 + 600, (B.z0 + B.z1) / 2, 1200, D + 2400], [(B.x0 + B.x1) / 2, B.z0 - 600, W, 1200]];
    for (const [x, z, w, d] of ring) { const m = box(w, 0.2, d, outer, x, -0.35, z); scene.add(m); }
  }

  // ----- roads: laterite shoulders, tarmac, edge lines, lane markings, bridges, electric poles -----
  {
    const buf = () => ({ pos: [], idx: [], col: [] });
    const layers = { shoulder: buf(), tarmac: buf(), paint: buf() };
    const tmp = new THREE.Color();
    // A strip running along a sampled road at a sideways `offset` from its centre line.
    function strip(layer, R, offset, width, yOff, keep, shade) {
      const { pos, idx, col } = layers[layer], base = pos.length / 3, n = R.sm.length;
      for (let i = 0; i < n; i++) {
        const [x, z] = R.sm[i], nx = -R.tz[i], nz = R.tx[i];
        for (const s of [-1, 1]) {
          pos.push(x + nx * (offset + s * width / 2), R.y[i] + yOff, z + nz * (offset + s * width / 2));
          if (shade) { tmp.set(shade).offsetHSL(0, 0, (R.noise[i] - 0.5) * 0.02); col.push(tmp.r, tmp.g, tmp.b); }
        }
        if (i < n - 1 && (!keep || keep(i))) {
          const k = base + i * 2;
          idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        }
      }
    }
    const concrete = L(0xcfd2d6);
    const poleSpots = [];
    ROADS.forEach((r, ri) => {
      const sm = samplePath(r.pts, 1.5), n = sm.length;
      const R = { sm, tx: [], tz: [], y: [], noise: [] };
      for (let i = 0; i < n; i++) {
        const a = sm[Math.max(i - 1, 0)], b = sm[Math.min(i + 1, n - 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        R.tx.push((b[0] - a[0]) / l); R.tz.push((b[1] - a[1]) / l);
        R.y.push(roadY(sm[i][0], sm[i][1]));
        R.noise.push(rng());
      }
      const w = r.width;
      // a marking segment is drawn only where it is clear of crossing roads, so junctions stay clean
      const clear = (off) => (i) => {
        const x = (sm[i][0] + sm[i + 1][0]) / 2 - R.tz[i] * off, z = (sm[i][1] + sm[i + 1][1]) / 2 + R.tx[i] * off;
        return !onCrossingRoad(x, z, ri, R.tx[i], R.tz[i], 0.6);
      };
      const dashed = (off, on, period, phase = 0) => { const c = clear(off); return (i) => (i + phase) % period < on && c(i); };
      strip('shoulder', R, 0, w + (r.cls === 'q' ? 1.4 : 2.6), 0.05, null, 0xa9785a);
      strip('tarmac', R, 0, w, 0.1, null, r.cls === 'q' ? 0x55565b : 0x4a4b51);
      if (r.cls !== 'q') for (const s of [-1, 1]) strip('paint', R, s * (w / 2 - 0.35), 0.15, 0.14, clear(s * (w / 2 - 0.35)));
      if (r.cls === 't') {         // four lanes: double centre line, dashed lane lines
        for (const s of [-1, 1]) strip('paint', R, s * 0.2, 0.13, 0.14, clear(0));
        for (const s of [-1, 1]) strip('paint', R, s * w / 4, 0.13, 0.14, dashed(s * w / 4, 2, 6));
      } else if (r.cls !== 'q') strip('paint', R, 0, 0.15, 0.14, dashed(0, 2, 5));

      for (let i = 0; i < n - 1; i++) {
        const [ax, az] = sm[i], [bx, bz] = sm[i + 1];
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        if (heightAt(mx, mz) > WORLD.water + 0.1) {
          // electric poles along the bigger roads, on alternating sides
          if (r.cls !== 'q' && i % 28 === 14) {
            const side = (ri + Math.floor(i / 28)) % 2 ? 1 : -1, off = w / 2 + 1.9;
            const x = mx - R.tz[i] * off * side, z = mz + R.tx[i] * off * side;
            if (distToRoad(x, z) > 1.2 && waterDist(x, z) > 2) poleSpots.push([x, z, Math.atan2(R.tx[i], R.tz[i])]);
          }
          continue;
        }
        // bridge deck, rails and piers over water
        const len = Math.hypot(bx - ax, bz - az), g = new THREE.Group();
        g.position.set(mx, R.y[i], mz);
        g.rotation.y = Math.atan2(bx - ax, bz - az);
        g.add(box(w + 2.2, 0.5, len + 0.05, concrete, 0, -0.22, 0));
        for (const s of [-1, 1]) g.add(box(0.3, 0.9, len + 0.05, concrete, s * (w / 2 + 0.9), 0.45, 0));
        if (i % 8 === 0) g.add(box(w, 3.2, 1.2, concrete, 0, -1.9, 0));
        statics.add(g);
      }
    });
    const mk = (layer, mat) => {
      const { pos, idx, col } = layers[layer], geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      if (col.length) geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const road = new THREE.Mesh(geo, mat);
      road.userData.shadow = 'receive';
      scene.add(road);
    };
    const off = (f) => ({ polygonOffset: true, polygonOffsetFactor: f, polygonOffsetUnits: f });
    mk('shoulder', new THREE.MeshLambertMaterial({ vertexColors: true, ...off(-1) }));
    mk('tarmac', new THREE.MeshLambertMaterial({ vertexColors: true, ...off(-3) }));
    mk('paint', new THREE.MeshBasicMaterial({ color: 0xeeeeea, ...off(-6) }));

    // poles: post with a cross-arm, instanced
    const poleG = mergeGeometries([
      new THREE.CylinderGeometry(0.09, 0.13, 7, 5).translate(0, 3.5, 0),
      new THREE.BoxGeometry(1.5, 0.1, 0.1).translate(0, 6.5, 0),
      new THREE.BoxGeometry(1.1, 0.08, 0.08).translate(0, 5.9, 0),
    ]);
    const poles = new THREE.InstancedMesh(poleG, L(0x8d8f93), poleSpots.length);
    const pm = new THREE.Matrix4(), pq = new THREE.Quaternion();
    poleSpots.forEach(([x, z, rot], i) => {
      pm.compose(V(x, heightAt(x, z), z), pq.setFromAxisAngle(V(0, 1, 0), rot), V(1, 1, 1));
      poles.setMatrixAt(i, pm);
      colliders.push({ x, z, r: 0.2 });
    });
    scene.add(poles);
  }

  // ----- paddy fields (bunds between the plots) -----
  {
    const shades = [L(0x9bd65c), L(0x86c94e), L(0xa9dc6a)];
    for (const p of PADDIES) {
      const nx = Math.max(1, Math.round((p.x1 - p.x0) / 20)), nz = Math.max(1, Math.round((p.z1 - p.z0) / 18));
      const w = (p.x1 - p.x0) / nx, d = (p.z1 - p.z0) / nz;
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const x = p.x0 + w * (i + 0.5), z = p.z0 + d * (j + 0.5);
        statics.add(box(w - 1.2, 0.14, d - 1.2, shades[(i + j) % 3], x, heightAt(x, z) + 0.07, z));
      }
    }
    const lm = LANDMARKS.find((l) => l.id === 'paddy');
    const g = new THREE.Group();
    g.position.set(lm.x, heightAt(lm.x, lm.z), lm.z);
    g.add(box(0.15, 2.6, 0.15, L(0x6b4423), 0, 1.3, 0), box(2, 0.15, 0.15, L(0x6b4423), 0, 1.9, 0));
    g.add(box(0.9, 0.9, 0.3, L(0xf2efe6), 0, 1.6, 0), cyl(0.3, 0.3, 0.5, L(0x8b4a2b), 0, 2.75, 0, 7));
    scene.add(g);
  }

  const lmk = (id) => LANDMARKS.find((l) => l.id === id);

  // A shopkeeper standing at (x, z) facing `rot`, registered as someone you can talk to.
  function addKeeper(x, z, rot, type) {
    const i = shops.length;
    const mesh = makeKeeper(i);
    mesh.position.set(x, heightAt(x, z), z);
    mesh.rotation.y = rot;
    scene.add(mesh);
    colliders.push({ x, z, r: 0.4 });
    shops.push({ x, z, type, keeper: KEEPERS[i % KEEPERS.length], mesh });
  }

  // ----- Parassinikadavu Muthappan temple: tiered roofs, ghat down to the Valapattanam -----
  const temple = lmk('temple');
  {
    const g = new THREE.Group();
    g.position.set(temple.bx, heightAt(temple.bx, temple.bz), temple.bz);
    g.rotation.y = temple.rot;
    const stone = L(0xb9b1a2), wall = L(0xf4ecd8), tile = L(0xb24a2c), gold = L(0xd4a72c), wood = L(0x6b4423), bronze = L(0x8c6a2f);
    g.add(box(22, 1.2, 16, stone, 0, 0, 0));
    g.add(box(16, 3.4, 10, wall, 0, 2.3, 0), hip(21, 2.6, 15, tile, 0, 4.0, 0));
    g.add(box(9, 2.0, 6, wall, 0, 6.2, 0), hip(12.5, 2.2, 9.5, tile, 0, 7.2, 0));
    g.add(box(4, 1.4, 3.4, wall, 0, 8.9, 0), hip(6.6, 2.2, 5.6, tile, 0, 9.6, 0));
    g.add(cyl(0.05, 0.3, 1.3, gold, 0, 12.3, 0, 6));
    g.add(box(1.6, 2.4, 0.2, wood, 0, 1.8, 5.05));
    for (const x of [-5.5, -2.2, 2.2, 5.5]) g.add(box(0.5, 3.4, 0.5, wood, x, 2.3, 5.3));
    for (const [x, z] of [[-3, 7.6], [3, 7.6]]) g.add(box(0.4, 3, 0.4, wood, x, 2.1, z));
    g.add(hip(8.5, 1.5, 4.6, tile, 0, 3.6, 6.6));
    // stone ghat steps down towards the river behind the temple
    for (let i = 0; i < 8; i++) g.add(box(11, 0.3, 1.6, stone, 0, 0.3 - i * 0.28, -8.8 - i * 1.6));
    g.add(cyl(0.12, 0.12, 5.6, gold, -5, 3.1, 11, 6));
    for (let i = 0; i < 7; i++) g.add(cyl(1 - i * 0.11, 1 - i * 0.11, 0.12, gold, -5, 0.9 + i * 0.75, 11, 10));
    g.add(cyl(0.6, 0.8, 0.6, stone, -5, 0.3, 11, 8));
    g.add(cyl(0.12, 0.2, 11, gold, 5, 5.5, 11, 6), cyl(0.6, 0.8, 0.6, stone, 5, 0.3, 11, 8));
    for (const sx of [-1, 1]) { // the temple's bronze dog statues
      g.add(box(0.9, 0.7, 1.5, stone, sx * 2.4, 0.95, 9.2));
      g.add(box(0.35, 0.4, 0.9, bronze, sx * 2.4, 1.65, 9.2), box(0.3, 0.32, 0.36, bronze, sx * 2.4, 1.98, 9.7));
    }
    scene.add(g);
    const T = local(temple.bx, temple.bz, temple.rot);
    for (const [x, z, r] of [[-5, 0, 8.5], [5, 0, 8.5], [-5, 11, 1], [5, 11, 0.9]]) { const [cx, cz] = T(x, z); colliders.push({ x: cx, z: cz, r }); }

    // ferry boat on the river behind the temple
    let fx = 0, fz = -26;
    for (let d = 20; d < 60; d += 2) { const [x, z] = T(0, -d); if (waterDist(x, z) < -4) { fz = -d - 4; break; } }
    const [bx0, bz0] = T(fx, fz);
    const boat = new THREE.Group();
    boat.add(box(12, 1.1, 3.6, L(0x2a5d8f), 0, -0.25, 0), box(8, 0.12, 3.4, L(0xf2efe6), 0, 2.2, 0));
    for (const x of [-3.6, 3.6]) for (const z of [-1.5, 1.5]) boat.add(box(0.15, 1.9, 0.15, L(0xf2efe6), x, 1.25, z));
    boat.rotation.y = temple.rot + Math.PI / 2;
    scene.add(boat);
    animated.push((t) => boat.position.set(bx0 + Math.sin(t * 0.08) * 6 * Math.cos(temple.rot), WORLD.water + 0.6 + Math.sin(t * 1.3) * 0.06,
      bz0 - Math.sin(t * 0.08) * 6 * Math.sin(temple.rot)));
  }

  // ----- Muzhappilangad drive-in beach -----
  {
    const [ex, ez] = BEACH_ENTRY;
    const sign = makeLabel('Muzhappilangad Drive-in Beach', { bg: '#1565c0', height: 1.5 });
    sign.position.set(ex, roadY(ex, ez) + 8.4, ez);
    scene.add(sign);
    for (const s of [-1, 1]) { const x = ex + s * 7, z = ez; scene.add(box(0.6, 6, 0.6, L(0xf2efe6), x, roadY(x, z) + 3, z)); colliders.push({ x, z, r: 0.6 }); }
    scene.add(box(15, 1.4, 0.7, L(0x1565c0), ex, roadY(ex, ez) + 6.2, ez));
    // fishing boats pulled up on the sand, close to the waterline
    const boatCols = [0x1e88e5, 0xe53935, 0xfdd835, 0x43a047, 0x1e88e5, 0xfb8c00, 0xe53935, 0xfdd835];
    const beach = lmk('beach');
    let placed = 0;
    for (let i = 0; i < 4000 && placed < boatCols.length; i++) {
      const x = beach.x + (rng() - 0.5) * 120, z = beach.z + (rng() - 0.5) * 320;
      const sd = waterDist(x, z);
      if (surfaceAt(x, z) !== SURF.drivein || sd < 4 || sd > 9 || colliders.some((c) => Math.hypot(c.x - x, c.z - z) < 25)) continue;
      const b = new THREE.Group();
      const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.45, 7, 6), L(boatCols[placed]));
      hull.rotation.x = Math.PI / 2;
      hull.scale.set(1, 1, 0.55);
      b.add(hull, box(1.3, 0.1, 5.5, L(0x6b4423), 0, 0.28, 0));
      b.position.set(x, heightAt(x, z) + 0.5, z);
      b.rotation.set(0, rng() * 6.28, 0.12);
      scene.add(b);
      colliders.push({ x, z, r: 2.6 });
      placed++;
    }
  }

  // ----- St. Angelo Fort: laterite walls, triangular bastions, cannons facing the sea -----
  {
    const f = lmk('fort');
    const g = new THREE.Group();
    g.position.set(f.bx, heightAt(f.bx, f.bz), f.bz);
    g.rotation.y = f.rot;
    const laterite = L(0xa0522d), dark = L(0x6d3a22), grassTop = L(0x6aa84f), iron = L(0x2b2b2b);
    const S = 13, Hh = 4.5;
    g.add(box(2 * S, 0.6, 2 * S, grassTop, 0, 0.3, 0));
    for (const [x, z, w, d] of [[0, S, 2 * S, 1.6], [0, -S, 2 * S, 1.6], [S, 0, 1.6, 2 * S], [-S, 0, 1.6, 2 * S]]) {
      g.add(box(w, Hh, d, laterite, x, Hh / 2, z));
      // crenellations
      const n = Math.round(Math.max(w, d) / 2.2);
      for (let k = 0; k < n; k += 2) {
        const t = -1 + (2 * (k + 0.5)) / n;
        g.add(box(w > d ? 1.1 : 1.7, 0.8, w > d ? 1.7 : 1.1, laterite, x + (w > d ? t * S : 0), Hh + 0.4, z + (w > d ? 0 : t * S)));
      }
    }
    // gate on the land side
    g.add(box(4, 3.4, 1.8, dark, 0, 1.7, -S));
    // diamond bastions at the corners
    const bast = new THREE.CylinderGeometry(4.2, 4.6, Hh + 0.6, 4);
    for (const [x, z] of [[S, S], [-S, S], [S, -S], [-S, -S]]) {
      const m = new THREE.Mesh(bast, laterite);
      m.position.set(x, (Hh + 0.6) / 2, z);
      g.add(m);
    }
    // cannons along the sea wall
    for (const x of [-8, -3, 3, 8]) {
      const c = cyl(0.3, 0.38, 2.6, iron, x, Hh + 0.9, S + 0.6, 8);
      c.rotation.x = Math.PI / 2 - 0.12;
      g.add(c, box(1.1, 0.5, 1.4, dark, x, Hh + 0.3, S - 0.5));
    }
    // a small chapel-like barracks inside
    g.add(box(8, 3, 5, L(0xe8dcc4), -2, 1.5 + 0.6, -3), hip(10, 2, 7, L(0xb24a2c), -2, 3.6, -3));
    scene.add(g);
    const F = local(f.bx, f.bz, f.rot);
    for (const [x, z] of [[-S, -S], [S, -S], [-S, S], [S, S], [0, -S], [0, S], [-S, 0], [S, 0], [-6, -S], [6, -S], [-6, S], [6, S], [-S, -6], [-S, 6], [S, -6], [S, 6], [-2, -3]])
      { const [cx, cz] = F(x, z); colliders.push({ x: cx, z: cz, r: x === -2 ? 5 : 4.2 }); }
  }

  // ----- Kannur lighthouse: red and white striped tower -----
  {
    const l = lmk('lighthouse');
    const g = new THREE.Group();
    g.position.set(l.bx, heightAt(l.bx, l.bz), l.bz);
    const red = L(0xc62828), white = L(0xf5f5f5), black = L(0x222222);
    g.add(cyl(3, 3.4, 1.2, L(0xcfd2d6), 0, 0.6, 0, 10));
    for (let i = 0; i < 6; i++) g.add(cyl(1.9 - (i + 1) * 0.08, 1.9 - i * 0.08, 3, i % 2 ? white : red, 0, 1.2 + 1.5 + i * 3, 0, 12));
    g.add(cyl(2.2, 2.2, 0.3, black, 0, 19.4, 0, 12));
    g.add(cyl(1.1, 1.1, 2, new THREE.MeshBasicMaterial({ color: 0xfff3a0 }), 0, 20.6, 0, 10));
    g.add(new THREE.Mesh(new THREE.ConeGeometry(1.4, 1.4, 10), red).translateY(22.3));
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.5, 9), new THREE.MeshBasicMaterial({ color: 0xfff6c0, transparent: true, opacity: 0.35, fog: false }));
    lamp.position.set(0, 20.6, 0);
    g.add(lamp);
    animated.push((t) => { lamp.rotation.y = t * 0.9; });
    scene.add(g);
    colliders.push({ x: l.bx, z: l.bz, r: 3.2 });
  }

  // ----- Payyambalam beach: sign and a few beach benches -----
  {
    const p = lmk('payyambalam');
    const s = makeLabel('Payyambalam Beach', { bg: '#00796b', height: 1.4 });
    s.position.set(p.x, heightAt(p.x, p.z) + 5, p.z);
    scene.add(s);
    for (let i = 0; i < 4; i++) {
      const x = p.x + Math.cos(i * 1.7) * 12, z = p.z + Math.sin(i * 1.7) * 18;
      if (waterDist(x, z) < 2) continue;
      const y = heightAt(x, z);
      const u = new THREE.Group();
      u.position.set(x, y, z);
      u.add(cyl(0.08, 0.08, 2.6, L(0xeeeeee), 0, 1.3, 0, 5), new THREE.Mesh(new THREE.ConeGeometry(1.8, 0.7, 8), L(i % 2 ? 0xe53935 : 0xfdd835)).translateY(2.7));
      u.add(box(2, 0.12, 0.6, L(0x6b4423), 1.5, 0.45, 0));
      scene.add(u);
      colliders.push({ x, z, r: 0.5 });
    }
  }

  // ----- chayakada at Chovva junction -----
  {
    const c = lmk('chayakada');
    const g = new THREE.Group();
    g.position.set(c.bx, heightAt(c.bx, c.bz), c.bz);
    g.rotation.y = c.rot + Math.PI; // the counter (-z in the model) faces the road
    g.add(box(6, 2.6, 4.5, L(0xe9dcc0), 0, 1.3, 0), hip(8.6, 2.2, 7, L(0x8b6b3d), 0, 2.6, 0));
    g.add(box(4, 1, 0.8, L(0x6b4423), -0.5, 0.5, -2.9), box(3.4, 0.12, 0.6, L(0x6b4423), -0.5, 0.5, -4.6));
    for (const x of [-1.8, 0.8]) g.add(box(0.15, 0.5, 0.5, L(0x6b4423), x, 0.25, -4.6));
    for (const x of [-1.6, -0.8, 0]) g.add(cyl(0.16, 0.16, 0.4, L(0xd9e7ef), x, 1.2, -2.9, 6));
    const s = makeLabel('ചായക്കട', { bg: '#7a2e1d', height: 1.1 });
    s.position.set(0, 5.4, 0);
    g.add(s);
    scene.add(g);
    colliders.push({ x: c.bx, z: c.bz, r: 4 });
    const kr = c.rot; // towards the road
    addKeeper(c.bx + Math.sin(kr) * 6.2 + Math.cos(kr) * 2.5, c.bz + Math.cos(kr) * 6.2 - Math.sin(kr) * 2.5, kr, SHOP_TYPES[0]);
  }

  // ----- the railway, Kannur station and the Thavakkara bus terminal (railway.js) -----
  const rail = buildRailway(scene, rng);
  colliders.push(...rail.colliders);
  animated.push(() => rail.update(Date.now() / 1000));

  // ----- Kannur town: Gandhi Circle, Arakkal Museum -----
  {
    const cream = L(0xf1e6c8), red = L(0xb5482e), white = L(0xf6f4ee), dark = L(0x26303a), wood = L(0x7a5230), grey = L(0xcfd2d6), slab = L(0xd9d5cc);
    const put = (lm, build, cols) => {
      const g = new THREE.Group();
      g.position.set(lm.bx, heightAt(lm.bx, lm.bz), lm.bz);
      g.rotation.y = lm.rot;
      build(g);
      scene.add(g);
      const T = local(lm.bx, lm.bz, lm.rot);
      for (const [x, z, r] of cols) { const [cx, cz] = T(x, z); colliders.push({ x: cx, z: cz, r }); }
    };
    // Gandhi Circle at Caltex junction: statue on a round plinth
    put(lmk('caltex'), (g) => {
      g.add(cyl(3, 3.2, 0.6, L(0x6aa84f), 0, 0.3, 0, 14), cyl(0.9, 1.1, 2.4, white, 0, 1.8, 0, 8));
      g.add(box(0.5, 1.1, 0.34, L(0x5a5a5a), 0, 3.6, 0), box(0.3, 0.32, 0.3, L(0x5a5a5a), 0, 4.3, 0), box(0.06, 1.5, 0.06, L(0x5a5a5a), 0.34, 3.5, 0.1));
      const sign = makeLabel('Gandhi Circle · ഗാന്ധി സർക്കിൾ', { bg: '#0f3d2e', height: 1.1 });
      sign.position.set(0, 6.2, 0);
      g.add(sign);
    }, [[0, 0, 3.1]]);
    // Arakkal Museum: long white two-storey palace wing with a tiled roof and wooden verandah
    put(lmk('arakkal'), (g) => {
      g.add(box(18, 6, 7, white, 0, 3, 0), hip(20, 2.8, 9, red, 0, 6, 0));
      g.add(box(18, 0.2, 2, wood, 0, 3, 4.4), box(18, 0.2, 2.4, red, 0, 5.9, 4.5));
      for (let i = 0; i <= 8; i++) g.add(box(0.22, 6, 0.22, wood, -8.8 + i * 2.2, 3, 5.3));
      for (let i = -3; i <= 3; i++) g.add(box(1, 1.6, 0.1, i ? dark : wood, i * 2.4, 1.3, 3.52), box(1, 1.4, 0.1, dark, i * 2.4, 4.3, 3.52));
      const sign = makeLabel('Arakkal Museum · അറക്കൽ', { bg: '#7a2e1d', height: 1.1 });
      sign.position.set(0, 9.6, 3);
      g.add(sign);
    }, [[-6, 0, 5], [0, 0, 5], [6, 0, 5]]);
  }

  const inTownCentre = (x, z) => Math.hypot(x + 500, z - 170) < 110;
  const nearLandmark = (x, z, pad) => LANDMARKS.some((m) => Math.hypot((m.bx ?? m.x) - x, (m.bz ?? m.z) - z) < pad)
    || rail.reserved.some(([rx, rz, r]) => Math.hypot(rx - x, rz - z) < r);

  // ----- building kit: many kinds of houses, shops and places of worship -----
  const PAL = {
    walls: [0xf5f0e1, 0xf7e7b0, 0xcfe8d0, 0xf4c9c0, 0xc9def0, 0xffffff, 0xf2a7a0, 0x9fd6c2, 0xf6c66a, 0xb7c9f2, 0xe6d3b3, 0xd9b8e8, 0xa8d08d, 0xf0e0d0].map((c) => L(c)),
    tile: [L(0xb5482e), L(0x9c3d27), L(0xc25a36)], tin: [L(0x3f6fa8), L(0x5b8f5b), L(0x8a8f96)],
    slab: L(0xd9d5cc), dark: L(0x26303a, { name: 'glass' }), door: L(0x5b3a1e), wood: L(0x7a5230), white: L(0xf6f4ee), green: L(0x2e7d32), gold: L(0xd4a72c),
    shutter: [L(0x8d949c), L(0x4a6fa5), L(0x4f7d5a), L(0x9a5b4a)], sign: [0xc62828, 0x1565c0, 0x2e7d32, 0xef6c00, 0x6a1b9a, 0x00838f, 0xf9a825].map((c) => L(c)),
    tank: L(0x1c1c1c), stone: L(0xb9b1a2),
  };
  const pickOf = (a) => a[Math.floor(rng() * a.length)];
  // a row of windows on the front (+z) face
  function windows(g, w, y, z, n = Math.max(1, Math.floor(w / 2))) {
    for (let i = 0; i < n; i++) g.add(box(0.9, 1.1, 0.08, PAL.dark, -w / 2 + (w / n) * (i + 0.5), y, z));
  }
  function worship(g) {
    const k = rng();
    if (k < 0.34) {           // mosque: white hall, green dome, two minarets
      g.add(box(8, 4, 7, PAL.white, 0, 2, 0));
      const dome = new THREE.Mesh(new THREE.SphereGeometry(2.2, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), PAL.green);
      dome.position.set(0, 4, 0);
      g.add(dome, cyl(0.06, 0.06, 1, PAL.gold, 0, 6.6, 0, 5));
      for (const sx of [-1, 1]) { g.add(cyl(0.45, 0.5, 8, PAL.white, sx * 3.6, 4, 3.1, 8), new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.4, 8), PAL.green).translateX(sx * 3.6).translateY(8.7).translateZ(3.1)); }
      g.add(box(1.6, 2.6, 0.1, PAL.green, 0, 1.3, 3.52));
      return [9, 4.2];
    }
    if (k < 0.67) {           // church: nave, steeple and cross
      g.add(box(6.5, 4.4, 9, PAL.white, 0, 2.2, -1), hip(7.4, 2.4, 9.8, PAL.tile[1], 0, 4.4, -1));
      g.add(box(2.6, 8, 2.6, PAL.white, 0, 4, 4), new THREE.Mesh(new THREE.ConeGeometry(2, 3, 4).rotateY(Math.PI / 4), PAL.tile[1]).translateY(9.5).translateZ(4));
      g.add(box(0.14, 1.4, 0.14, PAL.gold, 0, 11.6, 4), box(0.8, 0.14, 0.14, PAL.gold, 0, 11.8, 4), box(1.2, 2.2, 0.1, PAL.door, 0, 1.1, 5.32));
      return [11, 5.2];
    }
    // small temple: tiled shrine, lamp post and compound wall
    g.add(box(8, 0.5, 8, PAL.stone, 0, 0.25, 0), box(4.4, 2.6, 4.4, PAL.walls[0], 0, 1.8, 0), hip(6.4, 2.2, 6.4, PAL.tile[0], 0, 3.1, 0));
    g.add(box(1.6, 1.2, 1.6, PAL.walls[0], 0, 5.3, 0), hip(2.6, 1.4, 2.6, PAL.tile[0], 0, 5.6, 0), cyl(0.04, 0.2, 0.9, PAL.gold, 0, 7.4, 0, 6));
    g.add(cyl(0.1, 0.1, 3.6, PAL.gold, 2.4, 2.3, 3.2, 6), box(1.1, 2, 0.1, PAL.door, 0, 1.5, 2.22));
    return [7, 4.2];
  }
  function townBuilding(g) {
    if (rng() < 0.05) return worship(g);
    const floors = 1 + Math.floor(Math.pow(rng(), 1.6) * 4.99), w = 6 + rng() * 3, d = 6 + rng() * 1.6, fh = 2.9, h = floors * fh;
    const wall = pickOf(PAL.walls);
    g.add(box(w, h, d, wall, 0, h / 2, 0));
    // ground floor: rolling shutters, a signboard, sometimes an awning
    const bays = w > 7.5 ? 3 : 2;
    for (let i = 0; i < bays; i++) {
      const open = rng() < 0.55;
      g.add(box(w / bays - 0.5, 2.1, 0.1, open ? PAL.dark : pickOf(PAL.shutter), -w / 2 + (w / bays) * (i + 0.5), 1.05, d / 2 + 0.02));
    }
    g.add(box(w - 0.3, 0.7, 0.18, pickOf(PAL.sign), 0, 2.55, d / 2 + 0.1));
    if (rng() < 0.5) { const aw = box(w, 0.08, 1.5, pickOf(PAL.tin), 0, 2.2, d / 2 + 0.75); aw.rotation.x = 0.22; g.add(aw); }
    // upper floors: windows, sometimes balconies
    const balcony = rng() < 0.4;
    for (let f = 1; f < floors; f++) {
      windows(g, w - 0.6, f * fh + 1.5, d / 2 + 0.02);
      if (balcony) g.add(box(w, 0.12, 1, PAL.slab, 0, f * fh, d / 2 + 0.5), box(w, 0.7, 0.08, PAL.slab, 0, f * fh + 0.4, d / 2 + 1));
    }
    // roof: tiles on low buildings, otherwise a parapet with a water tank
    if (floors <= 2 && rng() < 0.35) g.add(hip(w + 1, 2, d + 1, pickOf(PAL.tile), 0, h, 0));
    else {
      g.add(box(w + 0.3, 0.35, d + 0.3, PAL.slab, 0, h + 0.17, 0));
      if (rng() < 0.6) g.add(cyl(0.6, 0.6, 1.1, PAL.tank, w / 2 - 1.2, h + 0.95, -d / 2 + 1.2, 8));
      if (floors >= 3 && rng() < 0.4) g.add(box(2.4, 1.6, 0.12, pickOf(PAL.sign), -w / 4, h + 1.2, d / 2 - 0.2)); // hoarding
    }
    return [h, d / 2];
  }
  function ruralBuilding(g) {
    const k = rng(), wall = pickOf(PAL.walls);
    let w, d, h;
    if (k < 0.04) return worship(g);
    if (k < 0.36) {            // tiled single-storey house with a sit-out
      w = 6 + rng() * 2.5; d = 5 + rng() * 1.5; h = 3;
      g.add(box(w, h, d, wall, 0, h / 2, 0), hip(w + 2, 2.2 + rng() * 0.6, d + 2, pickOf(PAL.tile), 0, h, 0));
      g.add(box(1.1, 2, 0.1, PAL.door, 0, 1, d / 2 + 0.02), box(w * 0.6, 0.15, 1.8, PAL.slab, 0, 0.08, d / 2 + 0.9));
      for (const sx of [-1, 1]) g.add(box(0.2, 2.6, 0.2, PAL.white, sx * w * 0.28, 1.3, d / 2 + 1.6), box(0.9, 1, 0.08, PAL.dark, sx * w * 0.32, 1.7, d / 2 + 0.02));
    } else if (k < 0.62) {     // two-storey concrete house, bright paint, car porch
      w = 6.5 + rng() * 2; d = 6; h = 6;
      g.add(box(w, h, d, wall, 0, h / 2, 0), box(w + 0.4, 0.3, d + 0.4, PAL.slab, 0, h + 0.15, 0));
      g.add(box(w * 0.5, 0.2, 2.6, PAL.slab, w * 0.2, 3, d / 2 + 1.3));
      for (const sx of [0, 1]) g.add(box(0.25, 3, 0.25, PAL.white, w * 0.2 + (sx - 0.5) * w * 0.44, 1.5, d / 2 + 2.4));
      g.add(box(1.1, 2.1, 0.1, PAL.door, -w * 0.2, 1.05, d / 2 + 0.02));
      windows(g, w - 0.8, 4.4, d / 2 + 0.02, 3);
      if (rng() < 0.6) g.add(cyl(0.55, 0.55, 1, PAL.tank, -w / 2 + 1.1, h + 0.8, -d / 2 + 1.1, 8));
      if (rng() < 0.4) g.add(hip(w * 0.6, 1.4, d * 0.6, pickOf(PAL.tile), 0, h + 0.3, 0));
    } else if (k < 0.76) {     // traditional long house with a deep tiled roof and pillared verandah
      w = 9.5; d = 5.5; h = 2.8;
      g.add(box(w, h, d, PAL.walls[0], 0, h / 2, 0), hip(w + 3, 3, d + 4, PAL.tile[1], 0, h - 0.2, 0.6));
      for (let i = 0; i < 5; i++) g.add(box(0.22, 2.6, 0.22, PAL.wood, -w / 2 + 0.6 + (i * (w - 1.2)) / 4, 1.3, d / 2 + 1.8));
      g.add(box(w, 0.25, 2.2, PAL.slab, 0, 0.12, d / 2 + 1.1), box(1.2, 2, 0.1, PAL.door, 0, 1, d / 2 + 0.02));
    } else if (k < 0.9) {      // small roadside shop with a tin awning
      w = 4 + rng() * 2; d = 3.6; h = 2.8;
      g.add(box(w, h, d, wall, 0, h / 2, 0), box(w + 0.3, 0.12, d + 0.3, pickOf(PAL.tin), 0, h + 0.06, 0));
      const aw = box(w + 0.4, 0.07, 1.6, pickOf(PAL.tin), 0, 2.4, d / 2 + 0.8); aw.rotation.x = 0.2;
      g.add(aw, box(w - 0.6, 2, 0.1, PAL.dark, 0, 1.05, d / 2 + 0.02), box(w - 0.4, 0.5, 0.12, pickOf(PAL.sign), 0, 2.95, d / 2 + 0.2), box(w - 1, 0.9, 0.5, PAL.wood, 0, 0.45, d / 2 + 0.5));
      return [h, d / 2, true];
    } else {                   // tin-roofed shed or godown
      w = 8; d = 6; h = 3.6;
      g.add(box(w, h, d, L(0xb9b4a6), 0, h / 2, 0));
      const r1 = box(w + 0.6, 0.1, d / 2 + 0.6, PAL.tin[2], 0, h + 0.5, d / 4), r2 = box(w + 0.6, 0.1, d / 2 + 0.6, PAL.tin[2], 0, h + 0.5, -d / 4);
      r1.rotation.x = 0.3; r2.rotation.x = -0.3;
      g.add(r1, r2, box(3, 2.8, 0.1, pickOf(PAL.shutter), 0, 1.4, d / 2 + 0.02));
    }
    // compound wall with a gate gap, for homes
    if (k < 0.76 && rng() < 0.55) for (const sx of [-1, 1]) g.add(box(w * 0.5, 0.9, 0.2, PAL.white, sx * (w * 0.25 + 1), 0.45, d / 2 + 3.2));
    return [h, d / 2];
  }

  // ----- houses and shops along the real roads -----
  const occupied = new Set();
  const occKey = (x, z) => Math.floor(x / 8) * 100003 + Math.floor(z / 8);
  const free = (x, z) => {
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (occupied.has(occKey(x + i * 8, z + j * 8))) return false;
    return true;
  };
  {
    const town = (x, z) => Math.hypot(x + 500, z - 170) < 170 || Math.hypot(x + 80, z - 220) < 40; // Kannur town, Chovva
    const keep = { t: 0.8, p: 0.75, s: 0.6, q: 0.4 };
    let townShops = 0;
    for (const road of ROADS) {
      const pts = samplePath(road.pts, 14);
      for (let i = 1; i < pts.length - 1; i++) {
        let tx = pts[i + 1][0] - pts[i - 1][0], tz = pts[i + 1][1] - pts[i - 1][1];
        const l = Math.hypot(tx, tz) || 1;
        tx /= l; tz /= l;
        for (const side of [-1, 1]) {
          const off = road.width / 2 + 7.8;
          const x = pts[i][0] - tz * side * off, z = pts[i][1] + tx * side * off;
          const inTown = town(x, z);
          if (rng() > (inTown ? 0.95 : keep[road.cls])) continue;
          if (x < B.x0 + 5 || x > B.x1 - 5 || z < B.z0 + 5 || z > B.z1 - 5) continue;
          if (waterDist(x, z) < 6 || surfaceAt(x, z) !== SURF.grass || distToRoad(x, z) < 2.6) continue;
          if (!free(x, z) || nearLandmark(x, z, 30)) continue;
          const g = new THREE.Group();
          g.position.set(x, heightAt(x, z), z);
          g.rotation.y = Math.atan2(tz * side, -tx * side); // face the road
          let h, foot;
          if (inTown) {
            [h, foot] = townBuilding(g);
            // every few town buildings has a shop you can stop at and talk to the shopkeeper
            if (h < 20 && ++townShops % 3 === 0 && shops.length < 48) {
              const type = SHOP_TYPES[shops.length % SHOP_TYPES.length], rot = g.rotation.y;
              const kx = x + Math.sin(rot) * (foot + 1.1), kz = z + Math.cos(rot) * (foot + 1.1);
              if (distToRoad(kx, kz) > 0.8) {
                const sign = makeLabel(`${type.name} · ${type.ml}`, { bg: type.sign, height: 1.2 });
                sign.position.set(x + Math.sin(rot) * (foot + 0.4), heightAt(x, z) + 4.6, z + Math.cos(rot) * (foot + 0.4));
                scene.add(sign);
                addKeeper(kx, kz, rot, type);
              }
            }
          } else {
            let isShop;
            [h, foot, isShop] = ruralBuilding(g);
            // roadside shops out of town have someone to talk to as well
            if (isShop && rng() < 0.45 && shops.length < 90) {
              const type = SHOP_TYPES[shops.length % SHOP_TYPES.length], rot = g.rotation.y;
              const kx = x + Math.sin(rot) * (foot + 1.5), kz = z + Math.cos(rot) * (foot + 1.5);
              if (distToRoad(kx, kz) > 0.8) {
                const sign = makeLabel(`${type.name} · ${type.ml}`, { bg: type.sign, height: 1 });
                sign.position.set(x, heightAt(x, z) + 4.2, z);
                scene.add(sign);
                addKeeper(kx, kz, rot, type);
              }
            }
          }
          statics.add(g);
          occupied.add(occKey(x, z));
          colliders.push({ x, z, r: Math.max(3, foot + 0.6) });
        }
      }
    }
  }
  statics.flush(scene);

  // ----- coconut palms (instanced), thickest along the coast as in Kannur -----
  {
    const palms = [];
    for (let i = 0; i < 60000 && palms.length < 3400; i++) {
      const x = B.x0 + rng() * (B.x1 - B.x0), z = B.z0 + rng() * (B.z1 - B.z0);
      const sd = waterDist(x, z);
      if (sd < 1.5) continue;
      if (rng() > (sd < 40 ? 0.9 : 0.22)) continue;
      const s = surfaceAt(x, z);
      if (s === SURF.paddy || s === SURF.drivein || distToRoad(x, z) < 4) continue;
      if (!free(x, z) && rng() < 0.9) continue;
      if (nearLandmark(x, z, 38) || inTownCentre(x, z)) continue;
      palms.push({ x, y: heightAt(x, z), z });
      colliders.push({ x, z, r: 0.35 });
    }
    // three trunk shapes (upright, leaning, strongly curved), each pointing its own way
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const palmMat = palmMaterial(), byShape = [[], [], []];
    palms.forEach((p) => byShape[Math.floor(rng() * 3)].push(p));
    byShape.forEach((list, v) => {
      const mats = list.map((p) => {
        const s = 0.85 + rng() * 0.4;
        e.set((rng() - 0.5) * 0.08, rng() * 6.28, (rng() - 0.5) * 0.08);
        return new THREE.Matrix4().compose(V(p.x, p.y - 0.1, p.z), q.setFromEuler(e), V(s, s * (0.9 + rng() * 0.25), s));
      });
      const lod = lodInstances(scene, coconutPalm(v), coconutPalm(v, true), palmMat, mats, { range: QUALITY.palmRange });
      animated.push((t, cam) => cam && lod(cam.position));
    });

    // broadleaf trees (mango, jackfruit) inland
    const tg = mergeGeometries([new THREE.CylinderGeometry(0.3, 0.4, 2.4, 5).toNonIndexed().translate(0, 1.2, 0), new THREE.IcosahedronGeometry(2.4, 0).translate(0, 4, 0)]);
    const spots = [];
    for (let i = 0; i < 20000 && spots.length < 900; i++) {
      const x = B.x0 + rng() * (B.x1 - B.x0), z = B.z0 + rng() * (B.z1 - B.z0);
      if (waterDist(x, z) < 40 || distToRoad(x, z) < 8 || surfaceAt(x, z) !== SURF.grass || !free(x, z) || nearLandmark(x, z, 38) || inTownCentre(x, z) || vnoise(x, z, 170) > 0.7) continue;
      spots.push([x, z]);
    }
    const trees = new THREE.InstancedMesh(tg, L(0x2f6f35), spots.length);
    spots.forEach(([x, z], i) => {
      const s = 0.8 + rng() * 0.9;
      m.compose(V(x, heightAt(x, z) - 0.2, z), q.identity(), V(s, s, s));
      trees.setMatrixAt(i, m);
      colliders.push({ x, z, r: 0.5 });
    });
    scene.add(trees);
  }

  // ----- more plant life, different in each kind of country -----
  {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    // scatter up to `max` instances of a model where accept(x, z) says the land suits it
    function scatter(max, geo, mat, accept, { min = 0.8, max: smax = 1.4, r = 0.4, sink = 0.1, far = null } = {}) {
      const spots = [];
      for (let i = 0; i < max * 40 && spots.length < max; i++) {
        const x = B.x0 + rng() * (B.x1 - B.x0), z = B.z0 + rng() * (B.z1 - B.z0);
        if (distToRoad(x, z) < 3.5 || surfaceAt(x, z) !== SURF.grass || nearLandmark(x, z, 36)) continue;
        if (!accept(x, z, waterDist(x, z))) continue;
        spots.push([x, z]);
      }
      const mats = spots.map(([x, z]) => {
        const sc = min + rng() * (smax - min);
        e.set(0, rng() * 6.28, 0);
        if (r) colliders.push({ x, z, r });
        return new THREE.Matrix4().compose(V(x, heightAt(x, z) - sink, z), q.setFromEuler(e), V(sc, sc * (0.85 + rng() * 0.3), sc));
      });
      if (far) { // a detailed model near the camera, a cheap one further away
        const lod = lodInstances(scene, geo, far, mat, mats, { range: QUALITY.palmRange });
        animated.push((t, cam) => cam && lod(cam.position));
        return;
      }
      const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
      mats.forEach((mm, i) => mesh.setMatrixAt(i, mm));
      scene.add(mesh);
    }
    const G = (list) => mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)));
    // areca palms: thin and tall, in groves inland
    scatter(1500, arecaPalm(), palmMaterial(),
      (x, z, sd) => sd > 20 && vnoise(x + 300, z + 80, 60) > 0.62 && free(x, z), { r: 0.2, far: arecaPalm(true) });
    // banana plants around the houses
    const leaf = (a) => new THREE.BoxGeometry(0.5, 0.05, 1.9).translate(0, 0, 0.95).rotateX(-0.75).rotateY(a).translate(0, 1.5, 0);
    scatter(1300, G([new THREE.CylinderGeometry(0.14, 0.18, 1.6, 5).translate(0, 0.8, 0), ...[0, 1.25, 2.5, 3.75, 5].map(leaf)]), L(0x7cc44f),
      (x, z, sd) => sd > 6 && !free(x, z) && rng() < 0.5, { min: 0.8, max: 1.3, r: 0.3 });
    // tall forest trees (teak, mahogany) on the inland hills
    scatter(1700, G([new THREE.CylinderGeometry(0.22, 0.32, 6, 5).translate(0, 3, 0), new THREE.IcosahedronGeometry(2.2, 0).scale(1, 1.5, 1).translate(0, 7.5, 0), new THREE.IcosahedronGeometry(1.5, 0).translate(0.8, 5.6, 0.4)]), L(0x2b6b3a),
      (x, z, sd) => sd > 30 && (heightAt(x, z) > 3.2 || (x > 150 && vnoise(x, z + 400, 90) > 0.55)) && free(x, z), { min: 0.9, max: 1.7, r: 0.45 });
    // mangroves along the river banks and backwaters
    scatter(1100, G([new THREE.IcosahedronGeometry(1.7, 0).scale(1, 0.6, 1).translate(0, 1.5, 0), new THREE.CylinderGeometry(0.5, 0.9, 1, 5, 1, true).translate(0, 0.5, 0)]), L(0x3a7a4f),
      (x, z, sd) => sd > 0.3 && sd < 7 && (x > -150 || z < -200), { min: 0.8, max: 1.6, r: 0, sink: 0.2 });
    // bushes and scrub on dry ground
    scatter(1400, G([new THREE.IcosahedronGeometry(0.9, 0).scale(1, 0.7, 1).translate(0, 0.5, 0)]), L(0x6f9a48),
      (x, z, sd) => sd > 8 && vnoise(x, z, 170) > 0.55, { min: 0.6, max: 1.5, r: 0 });
    // laterite boulders on the high ground
    scatter(350, new THREE.DodecahedronGeometry(1, 0).scale(1.2, 0.7, 1), L(0x8f5a3c),
      (x, z, sd) => sd > 30 && heightAt(x, z) > 4.5 && free(x, z), { min: 0.5, max: 1.8, r: 0.9, sink: 0.25 });
  }

  // ----- clouds -----
  {
    const cg = new THREE.IcosahedronGeometry(1, 0), cm = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, transparent: true, opacity: 0.9 });
    const clouds = [];
    for (let i = 0; i < 40; i++) {
      const g = new THREE.Group();
      for (let k = 0; k < 4; k++) {
        const b = new THREE.Mesh(cg, cm);
        b.scale.set(12 + rng() * 10, 4 + rng() * 3, 9 + rng() * 6);
        b.position.set(k * 10 - 15, rng() * 3, rng() * 8);
        g.add(b);
      }
      g.position.set(B.x0 - 300 + rng() * (B.x1 - B.x0 + 600), 110 + rng() * 50, B.z0 - 300 + rng() * (B.z1 - B.z0 + 600));
      scene.add(g);
      clouds.push(g);
    }
    let last = 0;
    animated.push((t) => {
      const dt = t - last; last = t;
      for (const c of clouds) { c.position.x += dt * 2; if (c.position.x > B.x1 + 300) c.position.x = B.x0 - 300; }
    });
  }

  // ----- light beams marking undiscovered places -----
  const beacons = new Map();
  {
    const bg = new THREE.CylinderGeometry(1.6, 1.6, 90, 8, 1, true);
    const bm = new THREE.MeshBasicMaterial({ color: 0xffd54f, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    for (const lm of LANDMARKS) {
      const b = new THREE.Mesh(bg, bm);
      b.position.set(lm.x, 45, lm.z);
      scene.add(b);
      beacons.set(lm.id, b);
    }
  }

  // shopkeepers wave now and then
  animated.push((t) => { for (let i = 0; i < shops.length; i++) shops[i].mesh.userData.arm.rotation.z = Math.max(0, Math.sin(t * 1.5 + i * 2)) * 2.2; });

  groundContactShade(terrainGeo, colliders);
  return { colliders, beacons, shops, trains: rail.trainBodies, update: (t, camera) => animated.forEach((f) => f(t, camera)) };
}

export { roadY };
