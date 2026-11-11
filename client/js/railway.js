// The Mangalore-Shoranur railway through the map, Kannur railway station and the Thavakkara bus
// terminal. Track positions come from OpenStreetMap (scripts/build-rail.py); the station and the
// terminal are modelled on photographs of them: a blue steel footbridge over the tracks, yellow
// three-language name boards, white-and-orange coaches and overhead electric line masts at the
// station; a curved steel-truss roof on round terracotta columns between orange-and-cream blocks at
// the terminal.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  RAILWAY, STATION, STATION_LAYOUT as SL, BUS_TERMINAL, RAIL_PTS, WORLD,
  samplePath, heightAt, waterDist, distToRoad, distToRoadOnly,
} from '/shared/world.js';
import { makeLabel } from './cars.js';
import { makeTrafficCar } from './traffic.js';

const L = (color, o = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...o });
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Many small parts merged into one mesh per material.
class Batch {
  constructor() { this.byMat = new Map(); }
  add(geo, mat, matrix) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (matrix) g.applyMatrix4(matrix);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (!this.byMat.has(mat)) this.byMat.set(mat, []);
    this.byMat.get(mat).push(g);
  }
  flush(scene) {
    for (const [mat, list] of this.byMat) for (let i = 0; i < list.length; i += 3000) scene.add(new THREE.Mesh(mergeGeometries(list.slice(i, i + 3000)), mat));
    this.byMat.clear();
  }
}

// A local frame: origin, heading `rot` (local +z along it), ground height y.
function frame(x, y, z, rot) {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), new THREE.Vector3(1, 1, 1));
  const at = (lx, ly, lz, ry = 0) => m.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(lx, ly, lz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(1, 1, 1)));
  const world = (lx, lz) => [x + lx * Math.cos(rot) + lz * Math.sin(rot), z - lx * Math.sin(rot) + lz * Math.cos(rot)];
  return { at, world };
}

/** A strip `width` wide at `offset` (to the left) along samples, `h` above each sample's y. */
function ribbon(S, offset, width, h, keep = () => true, thick = 0) {
  const pos = [];
  const P = (i, side, up) => [S[i].x + S[i].nx * (offset + side * width / 2), S[i].y + h + up, S[i].z + S[i].nz * (offset + side * width / 2)];
  for (let i = 0; i < S.length - 1; i++) {
    if (!keep(i)) continue;
    const a = P(i, -1, 0), b = P(i, 1, 0), c = P(i + 1, -1, 0), d = P(i + 1, 1, 0);
    pos.push(...a, ...c, ...b, ...b, ...c, ...d);
    if (thick) for (const side of [-1, 1]) {                // side walls, so a rail has a profile
      const e = P(i, side, 0), f = P(i + 1, side, 0), g = P(i, side, -thick), k = P(i + 1, side, -thick);
      if (side < 0) pos.push(...e, ...g, ...f, ...f, ...g, ...k); else pos.push(...e, ...f, ...g, ...f, ...k, ...g);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

export function buildRailway(scene, rng) {
  const batch = new Batch(), colliders = [], reserved = [];
  const mats = {
    ballast: L(0x8c8478), sleeper: L(0x6f6a64), rail: L(0x5b5550), railTop: L(0xb9b4ad),
    steel: L(0x6b7178), girder: L(0x55606b), concrete: L(0xc9c7c0), platform: L(0xd8d2c4), edge: L(0xf0d24a),
    fob: L(0x2f74c0), fobDark: L(0x1f4f8a), wire: new THREE.MeshBasicMaterial({ color: 0x2b2b2b, side: THREE.DoubleSide }),
    white: L(0xf4f1ea), cream: L(0xeee3c6), maroon: L(0x8e3b2f), red: L(0xc0392b), glass: L(0x2a3a48),
    roofSheet: L(0x9aa3ab, { side: THREE.DoubleSide }), canopy: L(0x6d8f6e), column: L(0xd2693c), orange: L(0xe8792f),
    coach: L(0xf2f0ea), coachBand: L(0xf08a24), coachRoof: L(0x9a9da1), coachWin: L(0x2b3640), kerbY: L(0xf2c418), kerbK: L(0x222222),
  };

  // ---------- the line, sampled every metre-ish, with its level, normal and position in the station frame ----------
  const stx = Math.sin(STATION.rot), stz = Math.cos(STATION.rot);
  const S = samplePath(RAIL_PTS, 1.2).map(([x, z], i, all) => {
    const a = all[Math.max(0, i - 1)], b = all[Math.min(all.length - 1, i + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const tx = (b[0] - a[0]) / l, tz = (b[1] - a[1]) / l;
    const sa = (x - STATION.x) * stx + (z - STATION.z) * stz, near = Math.hypot(x - STATION.x, z - STATION.z) < 120;
    return { x, z, tx, tz, nx: -tz, nz: tx, y: Math.max(heightAt(x, z), 0.15), a: near ? sa : 1e9, water: waterDist(x, z) < 1, road: distToRoadOnly(x, z) < 0.4 };
  });
  // the east track swings out round the island platform, with points either side of the station
  const eastOff = (s) => SL.eastTrack + (SL.eastTrackAtStation - SL.eastTrack) * sstep(SL.a0 - 52, SL.a0 - 30, s.a) * (1 - sstep(SL.a0 + 26, SL.a0 + 44, s.a));
  const tracks = [(s) => SL.westTrack, eastOff];
  const GAUGE = 1.676; // broad gauge, as in Kerala
  const offRoad = (i) => !S[i].road && !S[i + 1].road;

  for (const off of tracks) {
    const Soff = S.map((s) => ({ ...s, off: off(s) }));
    // ribbon wants a constant offset, so fold the offset into each sample's position
    const shifted = Soff.map((s) => ({ ...s, x: s.x + s.nx * s.off, z: s.z + s.nz * s.off }));
    batch.add(ribbon(shifted, 0, 3.4, 0.14, offRoad), mats.ballast);
    for (const side of [-1, 1]) {
      batch.add(ribbon(shifted, side * GAUGE / 2, 0.14, 0.4, () => true, 0.2), mats.rail);
    }
  }
  // sleepers, instanced
  {
    const spots = [];
    for (const off of tracks) {
      let acc = 0;
      for (let i = 1; i < S.length; i++) {
        acc += Math.hypot(S[i].x - S[i - 1].x, S[i].z - S[i - 1].z);
        if (acc < 0.7) continue;
        acc = 0;
        const s = S[i];
        if (s.road) continue;
        const o = off(s);
        spots.push([s.x + s.nx * o, s.y + 0.24, s.z + s.nz * o, Math.atan2(s.tx, s.tz)]);
      }
    }
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(2.7, 0.14, 0.26), mats.sleeper, spots.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
    spots.forEach(([x, y, z, r], i) => inst.setMatrixAt(i, m.compose(new THREE.Vector3(x, y, z), q.setFromAxisAngle(up, r), one)));
    scene.add(inst);
  }

  // ---------- bridges over water: a deck with steel girders and piers ----------
  for (let i = 0; i < S.length - 1; i++) {
    const s = S[i], t = S[i + 1];
    if (!s.water && !t.water) continue;
    const len = Math.hypot(t.x - s.x, t.z - s.z), f = frame((s.x + t.x) / 2, s.y, (s.z + t.z) / 2, Math.atan2(s.tx, s.tz));
    batch.add(new THREE.BoxGeometry(11, 0.5, len + 0.05), mats.concrete, f.at(0, -0.1, 0));
    for (const side of [-1, 1]) {
      batch.add(new THREE.BoxGeometry(0.35, 2.6, len + 0.05), mats.girder, f.at(side * 5.4, 1.1, 0));
      batch.add(new THREE.BoxGeometry(0.3, 0.3, len + 0.05), mats.girder, f.at(side * 5.4, 2.55, 0));
      if (i % 3 === 0) batch.add(new THREE.BoxGeometry(0.22, 3.2, 0.22), mats.girder, f.at(side * 5.4, 1.1, 0).multiply(new THREE.Matrix4().makeRotationX(0.75)));
    }
    if (i % 9 === 0) for (const side of [-1, 1]) batch.add(new THREE.CylinderGeometry(0.9, 1.1, 6, 8), mats.concrete, f.at(side * 3, -3.3, 0));
  }

  // ---------- overhead electric line: lattice masts with an arm, and a contact wire over each track ----------
  for (let i = 0, acc = 0; i < S.length; i++) {
    acc += i ? Math.hypot(S[i].x - S[i - 1].x, S[i].z - S[i - 1].z) : 0;
    if (acc < 30) continue;
    const s = S[i];
    if (s.water || s.road || distToRoadOnly(s.x, s.z) < 3) continue;
    acc = 0;
    const atStation = Math.abs(s.a - SL.a0) < 34;
    const f = frame(s.x, s.y, s.z, Math.atan2(s.tx, s.tz));
    // local x is to the right of the line, so a left offset o is at local x = -o
    for (const [o, dir] of atStation ? [[SL.westTrack - 2.2, 1]] : [[SL.westTrack - 2.2, 1], [SL.eastTrack + 2.2, -1]]) {
      batch.add(new THREE.BoxGeometry(0.32, 7.4, 0.32), mats.steel, f.at(-o, 3.7, 0));
      batch.add(new THREE.BoxGeometry(4.2, 0.14, 0.14), mats.steel, f.at(-o - dir * 2.0, 6.6, 0));
      const [cx, cz] = f.world(-o, 0);
      colliders.push({ x: cx, z: cz, r: 0.3 });
    }
  }
  for (const off of tracks) {
    const shifted = S.map((s) => { const o = off(s); return { ...s, x: s.x + s.nx * o, z: s.z + s.nz * o }; });
    batch.add(ribbon(shifted, 0, 0.05, 6.3), mats.wire);
  }

  // ---------- level crossings: red-and-white barriers either side of the tracks, raised ----------
  const boomGeo = mergeGeometries([0, 1, 2, 3, 4, 5].map((k) => new THREE.BoxGeometry(1.0, 0.16, 0.16).translate(0.5 + k, 0, 0).toNonIndexed()));
  const boomRed = mergeGeometries([0, 2, 4].map((k) => new THREE.BoxGeometry(1.02, 0.18, 0.18).translate(0.5 + k, 0, 0).toNonIndexed()));
  const gates = [];
  for (const [x, z] of RAILWAY.crossings) {
    const s = S.reduce((b, p) => (Math.hypot(p.x - x, p.z - z) < Math.hypot(b.x - x, b.z - z) ? p : b), S[0]);
    const f = frame(x, s.y, z, Math.atan2(s.tx, s.tz));
    for (const side of [-1, 1]) {
      const along = side * 6.5;
      batch.add(new THREE.BoxGeometry(0.35, 1.2, 0.35), mats.white, f.at(-5.5, 0.6, along));
      // the boom pivots on its post: up when the line is clear, down across the road for a train
      const pivot = new THREE.Group();
      pivot.applyMatrix4(f.at(-5.5, 1.2, along));
      const arm = new THREE.Group();
      arm.add(new THREE.Mesh(boomGeo, mats.white), new THREE.Mesh(boomRed, mats.red));
      arm.rotation.z = -1.25;
      pivot.add(arm);
      scene.add(pivot);
      gates.push({ x, z, arm });
      const sign = makeLabel('✕ RAILWAY CROSSING', { bg: '#ffffff', fg: '#c0392b', height: 0.55 });
      const [sx, sz] = f.world(6, along + side * 1.5);
      sign.position.set(sx, s.y + 2.4, sz);
      scene.add(sign);
      const [px, pz] = f.world(-5.5, along);
      colliders.push({ x: px, z: pz, r: 0.3 });
    }
  }

  // ---------- Kannur railway station ----------
  {
    const a0 = SL.a0, sx = STATION.x + stx * a0, sz = STATION.z + stz * a0;
    const y = Math.max(heightAt(sx, sz), 0.15);
    const f = frame(sx, y, sz, STATION.rot);
    const X = (o) => -o; // offsets are to the left of the line; local x points right
    const plat = ([from, to, len], label) => {
      const w = to - from, c = (from + to) / 2;
      batch.add(new THREE.BoxGeometry(w, 0.9, len), mats.platform, f.at(X(c), 0.45, 0));
      for (const e of [from, to]) batch.add(new THREE.BoxGeometry(0.35, 0.92, len), mats.edge, f.at(X(e + (e === from ? 0.17 : -0.17)), 0.46, 0));
      // shelter over the middle of the platform: sheet roof on columns
      batch.add(new THREE.BoxGeometry(w - 0.6, 0.18, len * 0.62), mats.canopy, f.at(X(c), 4.3, 0));
      for (let k = -4; k <= 4; k++) batch.add(new THREE.CylinderGeometry(0.13, 0.13, 3.4, 6), mats.steel, f.at(X(c), 2.6, k * len * 0.075));
      // benches
      for (let k = -2; k <= 2; k++) batch.add(new THREE.BoxGeometry(0.5, 0.45, 1.8), mats.maroon, f.at(X(c + w * 0.18), 1.12, k * 6 + 3));
      // yellow name boards near each end: Malayalam, Hindi, English
      for (const end of [-1, 1]) {
        const at = end * len * 0.36;
        for (const p of [-0.75, 0.75]) batch.add(new THREE.BoxGeometry(0.1, 2.6, 0.1), mats.steel, f.at(X(c), 2.2, at + p));
        const board = makeLabel('കണ്ണൂർ · कण्णूर · KANNUR', { bg: '#f7c51e', fg: '#151515', height: 0.8 });
        const [bx, bz] = f.world(X(c), at);
        board.position.set(bx, y + 3.3, bz);
        scene.add(board);
      }
      const [tx, tz] = f.world(X(c), 0);
      const n = makeLabel(label, { bg: '#1b4f8a', fg: '#ffffff', height: 0.5 });
      n.position.set(tx, y + 4.9, tz);
      scene.add(n);
    };
    plat(SL.island, 'Platform 2 · 3');
    plat(SL.platform1, 'Platform 1');

    // station building, facing the town: long two-storey front with a pitched-roof entrance porch
    const [b0, b1, blen, ba] = SL.building, bc = (b0 + b1) / 2, bd = b1 - b0, bz = ba - a0;
    batch.add(new THREE.BoxGeometry(bd, 7.2, blen), mats.cream, f.at(X(bc), 3.6, bz));
    batch.add(new THREE.BoxGeometry(bd + 0.6, 0.5, blen + 0.6), mats.maroon, f.at(X(bc), 7.45, bz));       // parapet band
    batch.add(new THREE.BoxGeometry(bd + 0.2, 0.35, blen + 0.2), mats.maroon, f.at(X(bc), 3.6, bz));       // floor band
    for (let k = -6; k <= 6; k++) for (const fy of [1.9, 5.4]) {                                             // windows on the town side
      if (Math.abs(k) <= 1 && fy < 3) continue;
      batch.add(new THREE.BoxGeometry(0.1, 1.5, 1.3), mats.glass, f.at(X(b1) - 0.02, fy, bz + k * 2.3));
    }
    // entrance porch: columns and a gabled roof, the sign above it
    const porch = X(b1 + 3);
    for (const k of [-3, 3]) for (const d of [-1.6, 1.6]) batch.add(new THREE.BoxGeometry(0.5, 4.4, 0.5), mats.white, f.at(porch + d, 2.2, bz + k));
    batch.add(new THREE.BoxGeometry(4.6, 0.4, 8), mats.white, f.at(porch, 4.6, bz));
    const gable = new THREE.CylinderGeometry(2.6, 2.6, 8.6, 3, 1).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).scale(1, 0.55, 1);
    batch.add(gable, mats.maroon, f.at(porch, 5.6, bz));
    batch.add(new THREE.BoxGeometry(0.1, 2.6, 2.6), mats.glass, f.at(X(b1) - 0.02, 1.3, bz));                // doorway
    {
      const sign = makeLabel('കണ്ണൂർ റെയിൽവേ സ്റ്റേഷൻ · KANNUR RAILWAY STATION', { bg: '#f7c51e', fg: '#151515', height: 1.1 });
      const [qx, qz] = f.world(X(b1) + 0.3, bz);
      sign.position.set(qx, y + 8.6, qz);
      scene.add(sign);
    }
    for (const k of [-1, 0, 1]) { const [cx, cz] = f.world(X(bc), bz + k * blen / 3); colliders.push({ x: cx, z: cz, r: bd / 2 + 0.5 }); }

    // blue steel footbridge: from the road on the west side, over both tracks, to the station building,
    // with stairs down to the roadside, the island platform and platform 1
    {
      const z = SL.footbridgeA - a0, west = SL.westTrack - 3.2, east = SL.building[0] + 0.4;
      const len = east - west, mid = (west + east) / 2, deckY = 7.2, half = 1.3;
      batch.add(new THREE.BoxGeometry(len, 0.35, 2.6), mats.fob, f.at(X(mid), deckY, z));          // deck
      batch.add(new THREE.BoxGeometry(len, 0.25, 2.8), mats.fob, f.at(X(mid), deckY + 2.4, z));    // roof
      for (const side of [-half - 0.05, half + 0.05]) {                                             // truss sides
        batch.add(new THREE.BoxGeometry(len, 0.18, 0.18), mats.fobDark, f.at(X(mid), deckY + 0.2, z + side));
        batch.add(new THREE.BoxGeometry(len, 0.18, 0.18), mats.fobDark, f.at(X(mid), deckY + 2.25, z + side));
        for (let k = 0; k <= Math.floor(len / 1.6); k++) {
          const o = west + k * 1.6;
          batch.add(new THREE.BoxGeometry(0.12, 2.1, 0.12), mats.fob, f.at(X(o), deckY + 1.2, z + side));
          if (k % 2 === 0 && o + 1.6 <= east) batch.add(new THREE.BoxGeometry(0.1, 2.6, 0.1), mats.fobDark, f.at(X(o + 0.8), deckY + 1.2, z + side).multiply(new THREE.Matrix4().makeRotationZ(0.62)));
        }
      }
      // a straight flight leaving the deck sideways (along the line) and stepping down to `bottom`
      const stairs = (o, bottom) => {
        const rise = 0.36, tread = 0.5, n = Math.ceil((deckY - bottom) / rise), run = n * tread, w = 1.9;
        const z0 = z + half + 1.2;                                                                    // landing beside the deck
        batch.add(new THREE.BoxGeometry(w + 0.4, 0.3, 2.4), mats.fob, f.at(X(o), deckY, z + half + 0.6));
        for (let k = 0; k < n; k++) {
          const top = deckY - k * rise;
          batch.add(new THREE.BoxGeometry(w, 0.14, tread + 0.04), mats.concrete, f.at(X(o), top - rise, z0 + k * tread + tread / 2));
        }
        const slope = Math.atan2(deckY - bottom, run), hyp = Math.hypot(run, deckY - bottom);
        for (const sd of [-w / 2 - 0.08, w / 2 + 0.08]) {
          const m = f.at(X(o) + sd, (deckY + bottom) / 2 - 0.2, z0 + run / 2).multiply(new THREE.Matrix4().makeRotationX(slope));
          batch.add(new THREE.BoxGeometry(0.16, 0.5, hyp), mats.fob, m);                                // stringer
          batch.add(new THREE.BoxGeometry(0.08, 0.08, hyp), mats.fobDark, m.clone().multiply(new THREE.Matrix4().makeTranslation(0, 1.1, 0))); // handrail
        }
        batch.add(new THREE.BoxGeometry(0.4, deckY, 0.4), mats.fob, f.at(X(o), deckY / 2, z + half + 0.6)); // column under the landing
        const [cx, cz] = f.world(X(o), z0 + run * 0.6);
        colliders.push({ x: cx, z: cz, r: 0.6 });
      };
      stairs(west + 0.2, 0);                                                       // down to the west road
      stairs((SL.island[0] + SL.island[1]) / 2, 0.9);                              // island platform 2 / 3
      stairs((SL.platform1[0] + SL.platform1[1]) / 2, 0.9);                        // platform 1
    }
    // keep houses and palms off the station's land
    for (const k of [-24, 0, 24]) { const [cx, cz] = f.world(X(14), k); reserved.push([cx, cz, 14]); }
  }

  // ---------- Thavakkara bus terminal ----------
  {
    // fit the terminal into the nearest clear plot to its real yard: no roads, no railway, no water
    const W = 30, D = 38, rot = STATION.rot, c = Math.cos(rot), s = Math.sin(rot);
    const clear = (cx, cz) => {
      for (let i = -W / 2; i <= W / 2; i += 3) for (let j = -D / 2; j <= D / 2; j += 3) {
        const x = cx + i * c + j * s, z = cz - i * s + j * c;
        if (distToRoad(x, z) < 1 || waterDist(x, z) < 3) return false;
      }
      return true;
    };
    let best = null, bd = Infinity;
    for (let dx = -50; dx <= 50; dx += 2) for (let dz = -50; dz <= 50; dz += 2) {
      const d = Math.hypot(dx, dz);
      if (d >= bd) continue;
      const cx = BUS_TERMINAL.x + dx, cz = BUS_TERMINAL.z + dz;
      if (clear(cx, cz)) { best = [cx, cz]; bd = d; }
    }
    best ??= [BUS_TERMINAL.x, BUS_TERMINAL.z];
    const [cx, cz] = best, y = heightAt(cx, cz);
    const f = frame(cx, y, cz, rot);
    BUS_TERMINAL.placed = { x: cx, z: cz, rot };

    // forecourt slab and the black-and-yellow kerbs along the driveway
    batch.add(new THREE.BoxGeometry(W, 0.2, D), mats.concrete, f.at(0, 0.1, 0));
    for (let k = -7; k <= 7; k++) batch.add(new THREE.BoxGeometry(1.0, 0.3, 0.35), k % 2 ? mats.kerbY : mats.kerbK, f.at(k * 1.0, 0.25, D / 2 - 0.2));

    // the curved steel roof over the bus bays: a shallow barrel vault with visible arch ribs
    const span = 16, rise = 3.6, R = (span * span / 4 + rise * rise) / (2 * rise), th = 2 * Math.asin(span / 2 / R), spring = 6.2;
    const vault = new THREE.CylinderGeometry(R, R, D - 6, 24, 1, true, -th / 2, th).rotateX(Math.PI / 2);
    batch.add(vault, mats.roofSheet, f.at(0, spring + rise - R, -1));
    for (let k = -4; k <= 4; k++) {                          // ribs
      const z = -1 + k * (D - 6) / 8.5;
      for (let seg = 0; seg < 10; seg++) {
        const a0 = -th / 2 + (seg / 10) * th, a1 = -th / 2 + ((seg + 1) / 10) * th;
        const p0 = [R * Math.sin(a0), R * Math.cos(a0)], p1 = [R * Math.sin(a1), R * Math.cos(a1)];
        const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        const m = f.at((p0[0] + p1[0]) / 2, spring + rise - R + (p0[1] + p1[1]) / 2 - 0.25, z).multiply(new THREE.Matrix4().makeRotationZ(-(a0 + a1) / 2));
        batch.add(new THREE.BoxGeometry(len + 0.05, 0.45, 0.25), mats.steel, m);
      }
    }
    // round terracotta columns along both sides
    for (const side of [-1, 1]) for (let k = -3; k <= 3; k++) {
      const z = -1 + k * 5;
      batch.add(new THREE.CylinderGeometry(0.55, 0.6, spring, 10), mats.column, f.at(side * span / 2, spring / 2, z));
      batch.add(new THREE.CylinderGeometry(0.75, 0.75, 0.5, 10), mats.white, f.at(side * span / 2, spring + 0.1, z));
      const [qx, qz] = f.world(side * span / 2, z);
      colliders.push({ x: qx, z: qz, r: 0.7 });
    }
    // bus bays: kerbed islands with private buses parked nose-in
    const paints = [0xc0392b, 0x1e8449, 0x2471a3, 0xd68910, 0x7d3c98, 0xe74c3c, 0x16a085];
    for (const side of [-1, 1]) for (let k = 0; k < 3; k++) {
      const z = -10 + k * 9;
      batch.add(new THREE.BoxGeometry(1.2, 0.25, 7), mats.concrete, f.at(side * 3.3, 0.32, z));
      const bus = makeTrafficCar('bus', paints[Math.floor(rng() * paints.length)]);
      const [bx, bz] = f.world(side * 5.6, z + 0.5);
      bus.position.set(bx, y + 0.2, bz);
      bus.rotation.y = rot + (side > 0 ? 0 : Math.PI);
      scene.add(bus);
      colliders.push({ x: bx, z: bz, r: 2.2 }, { x: bx + s * 3, z: bz + c * 3, r: 2.2 }, { x: bx - s * 3, z: bz - c * 3, r: 2.2 });
    }
    // orange-and-cream commercial blocks either side, the taller hotel block behind
    const block = (x, w, d, floors, zc, accent) => {
      const h = floors * 3.2;
      batch.add(new THREE.BoxGeometry(w, h, d), mats.cream, f.at(x, h / 2, zc));
      for (let fl = 0; fl < floors; fl++) {
        batch.add(new THREE.BoxGeometry(w + 0.2, 0.35, d + 0.2), accent, f.at(x, fl * 3.2 + 0.2, zc));
        const n = Math.floor((d / 2 - 1.2) / 3);             // window bays that fit inside the block
        for (let k = -n; k <= n; k++)
          batch.add(new THREE.BoxGeometry(w + 0.08, 1.4, 1.8), mats.glass, f.at(x, fl * 3.2 + 1.9, zc + k * 3));
      }
      for (let k = -1; k <= 1; k++) batch.add(new THREE.BoxGeometry(1.2, h + 0.4, 1.2), accent, f.at(x + Math.sign(x) * -(w / 2), (h + 0.4) / 2, zc + k * d / 3)); // orange fins
      for (const k of [-1, 0, 1]) { const [qx, qz] = f.world(x, zc + k * d / 3); colliders.push({ x: qx, z: qz, r: Math.max(w, d / 3) / 2 + 0.4 }); }
    };
    block(-(span / 2 + 3.6), 6, D - 8, 4, -2, mats.orange);
    block(span / 2 + 3.6, 6, D - 8, 4, -2, mats.orange);
    block(0, span - 2, 7, 6, -D / 2 + 2.5, mats.orange);                 // hotel block across the back
    // the striped canopy over the waiting area at the front
    // a light awning of red and white stripes, curved over the walkway
    const aw = 2.6, th0 = -0.75, dth = 1.5 / 8;
    for (let k = 0; k < 8; k++) {
      const strip = new THREE.CylinderGeometry(aw, aw, 11, 3, 1, true, th0 + k * dth, dth).rotateZ(Math.PI / 2);
      batch.add(strip, k % 2 ? mats.white : mats.red, f.at(0, 1.5, D / 2 - 4));
    }
    for (const sx of [-5.4, 5.4]) for (const sz of [-1.4, 1.4]) batch.add(new THREE.CylinderGeometry(0.12, 0.12, 3.6, 6), mats.steel, f.at(sx, 1.8, D / 2 - 4 + sz));
    {
      const sign = makeLabel('Thavakkara Bus Terminal · താവക്കര ബസ് ടെർമിനൽ', { bg: '#c0392b', height: 1.2 });
      const [qx, qz] = f.world(0, D / 2 - 6);
      sign.position.set(qx, y + spring + rise + 1.4, qz);
      scene.add(sign);
    }
    reserved.push([cx, cz, Math.hypot(W, D) / 2 + 2]);
  }

  batch.flush(scene);

  // ---------- trains: one each way on the double track, stopping at Kannur ----------
  // Positions come from the clock, like the road traffic, so every player sees the same trains.
  const coachMesh = (body, band) => {
    const b = new Batch(), g = new THREE.Group(), len = 10.2;
    b.add(new THREE.BoxGeometry(3.0, 3.1, len), body, new THREE.Matrix4().makeTranslation(0, 2.35, 0));
    b.add(new THREE.BoxGeometry(3.04, 0.45, len), band, new THREE.Matrix4().makeTranslation(0, 1.55, 0));
    b.add(new THREE.CylinderGeometry(1.5, 1.5, len, 10, 1, false, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2).scale(1, 0.25, 1), mats.coachRoof, new THREE.Matrix4().makeTranslation(0, 3.9, 0));
    for (let w = -3; w <= 3; w++) for (const sd of [-1, 1]) b.add(new THREE.BoxGeometry(0.06, 0.8, 0.9), mats.coachWin, new THREE.Matrix4().makeTranslation(sd * 1.51, 2.6, w * 1.3));
    for (const zz of [-len / 2 + 1.6, len / 2 - 1.6]) b.add(new THREE.BoxGeometry(2.6, 0.7, 2.0), mats.rail, new THREE.Matrix4().makeTranslation(0, 0.75, zz));
    b.flush(g);
    return g;
  };
  const locoMesh = () => {
    const g = coachMesh(mats.red, mats.white), b = new Batch();
    b.add(new THREE.BoxGeometry(3.06, 1.2, 1.4), mats.coachWin, new THREE.Matrix4().makeTranslation(0, 3.0, 4.6)); // cab windscreen
    b.add(new THREE.BoxGeometry(1.6, 0.3, 0.8), mats.steel, new THREE.Matrix4().makeTranslation(0, 4.35, 0));      // pantograph base
    b.add(new THREE.BoxGeometry(0.08, 1.6, 0.08), mats.steel, new THREE.Matrix4().makeRotationX(0.5).setPosition(0, 5.1, 0.3));
    b.flush(g);
    return g;
  };
  // each track as a path with cumulative length, so a coach can be placed at any distance along it
  const pathOf = (off) => {
    const pts = S.map((s) => { const o = off(s); return [s.x + s.nx * o, s.y + 0.4, s.z + s.nz * o, s.a]; });
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
    const len = cum[cum.length - 1];
    const at = (d) => {
      d = Math.max(0, Math.min(len, d));
      let lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
      const t = (d - cum[lo]) / (cum[hi] - cum[lo] || 1), p = pts[lo], q = pts[hi];
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
    };
    // distance along the path of the platform middle
    let stop = 0, bd = Infinity;
    pts.forEach((p, i) => { const d = Math.abs(p[3] - SL.a0); if (d < bd) { bd = d; stop = cum[i]; } });
    return { len, at, stop };
  };
  const CRUISE = 16, BRAKE = 70, DWELL = 25, GAP = 30, CARS = 8, PITCH = 10.7;
  const trains = [
    { path: pathOf(tracks[0]), dir: 1, phase: 0 },
    { path: pathOf(tracks[1]), dir: -1, phase: 97 },
  ].map((tr) => {
    const group = new THREE.Group(), cars = [locoMesh()];
    for (let k = 1; k < CARS; k++) cars.push(coachMesh(mats.coach, mats.coachBand));
    group.add(...cars);
    scene.add(group);
    // the schedule, in distance travelled from the start of this train's run
    const len = tr.path.len + CARS * PITCH, stop = tr.dir > 0 ? tr.path.stop : tr.path.len - tr.path.stop;
    const k = CRUISE * CRUISE / (4 * BRAKE);
    const tA = (stop - BRAKE) / CRUISE, tB = tA + 2 * BRAKE / CRUISE, tC = tB + DWELL, tD = tC + 2 * BRAKE / CRUISE;
    const period = tD + (len - stop - BRAKE) / CRUISE + GAP;
    const run = (u) => {
      if (u < tA) return CRUISE * u;
      if (u < tB) { const t = u - tA; return stop - BRAKE + CRUISE * t - k * t * t; }
      if (u < tC) return stop;
      if (u < tD) { const t = u - tC; return stop + k * t * t; }
      return stop + BRAKE + CRUISE * (u - tD);
    };
    return { ...tr, group, cars, run, period, bodies: [] };
  });
  const bodies = [];
  function update(now) {
    bodies.length = 0;
    for (const tr of trains) {
      const u = (now + tr.phase) % tr.period, d = tr.run(u); // distance of the locomotive along its run
      let any = false;
      tr.cars.forEach((car, i) => {
        const dc = d - i * PITCH;                            // coaches follow behind
        const inside = dc > 0 && dc < tr.path.len;
        car.visible = inside;
        if (!inside) return;
        any = true;
        const along = tr.dir > 0 ? dc : tr.path.len - dc;
        const front = tr.path.at(along + tr.dir * 4), back = tr.path.at(along - tr.dir * 4), mid = tr.path.at(along);
        car.position.set(mid[0], mid[1], mid[2]);
        car.rotation.set(0, Math.atan2(front[0] - back[0], front[2] - back[2]), 0);
        bodies.push({ x: mid[0], z: mid[2], r: 1.7 }, { x: (mid[0] + front[0]) / 2, z: (mid[2] + front[2]) / 2, r: 1.7 }, { x: (mid[0] + back[0]) / 2, z: (mid[2] + back[2]) / 2, r: 1.7 });
      });
      tr.group.visible = any;
    }
    // barriers come down while a train is within 80 units of the crossing
    for (const g of gates) {
      const near = bodies.some((b) => Math.abs(b.x - g.x) < 80 && Math.abs(b.z - g.z) < 80 && Math.hypot(b.x - g.x, b.z - g.z) < 80);
      const target = near ? 0 : -1.25;
      g.arm.rotation.z += (target - g.arm.rotation.z) * 0.08;
    }
  }
  return { colliders, reserved, update, trainBodies: bodies };
}
