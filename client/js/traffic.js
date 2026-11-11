// Buses, lorries, cars and autorickshaws driving the real roads.
// Each vehicle's position is a pure function of the clock, so every player sees the same traffic
// without the server sending anything.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROADS, TRAFFIC_COUNTS, heightAt } from '/shared/world.js';

// A box with one colour baked in. White parts take the per-vehicle paint colour.
function cbox(w, h, d, color, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed().translate(x, y, z);
  const c = new THREE.Color(color), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  return g;
}
const WHITE = 0xffffff, GLASS = 0x1b2630, TYRE = 0x151515, DARK = 0x2a2c30, LAMP = 0xfff2b0, TAIL = 0xb71c1c;
const wheels = (hw, zs, r = 0.45) => zs.flatMap((z) => [-1, 1].map((s) => cbox(0.3, r * 2, r * 2, TYRE, s * hw, r, z)));

// All models face +z.
const MODELS = {
  bus: { len: 9, r: 2.3, speed: 11, paints: [0xc0392b, 0x1e8449, 0x2471a3, 0xd68910, 0x7d3c98, 0xe74c3c, 0xf4f1e6], parts: [
    cbox(2.5, 2.5, 9, WHITE, 0, 1.75, 0), cbox(2.54, 0.85, 7.6, GLASS, 0, 2.25, -0.2), cbox(2.3, 1, 0.1, GLASS, 0, 2.2, 4.48),
    cbox(2.5, 0.35, 9, 0xf4f1e6, 0, 3.15, 0), cbox(2.52, 0.3, 9.02, DARK, 0, 0.62, 0), cbox(1.6, 0.4, 0.12, 0xf9c80e, 0, 2.95, 4.5),
    cbox(0.4, 0.25, 0.1, LAMP, -0.85, 1, 4.5), cbox(0.4, 0.25, 0.1, LAMP, 0.85, 1, 4.5), cbox(0.4, 0.25, 0.1, TAIL, -0.9, 1.1, -4.5), cbox(0.4, 0.25, 0.1, TAIL, 0.9, 1.1, -4.5),
    ...wheels(1.15, [2.8, -2.6], 0.5)] },
  lorry: { len: 7.4, r: 2.1, speed: 9, paints: [0xd68910, 0xb03a2e, 0x2e86c1, 0x6e8b3d], parts: [
    cbox(2.3, 1.9, 2, WHITE, 0, 1.75, 2.6), cbox(2.1, 0.8, 0.1, GLASS, 0, 2.15, 3.62), cbox(2.34, 0.7, 1.2, GLASS, 0, 2.2, 2.8),
    cbox(2.4, 1.6, 5, 0x8d6e4a, 0, 1.9, -1), cbox(2.44, 0.2, 5.04, WHITE, 0, 2.75, -1), cbox(2.2, 0.3, 7.2, DARK, 0, 0.75, 0),
    cbox(0.35, 0.22, 0.1, LAMP, -0.8, 1.05, 3.62), cbox(0.35, 0.22, 0.1, LAMP, 0.8, 1.05, 3.62), cbox(0.35, 0.22, 0.1, TAIL, -0.9, 1, -3.52), cbox(0.35, 0.22, 0.1, TAIL, 0.9, 1, -3.52),
    ...wheels(1.05, [2.5, -1.4, -2.6], 0.5)] },
  tcar: { len: 4.2, r: 1.5, speed: 13, paints: [0xe0e0e0, 0xb0b5ba, 0x34495e, 0x922b21, 0x1f618d, 0x212121, 0xf5f5f5, 0x8d6e63], parts: [
    cbox(1.75, 0.6, 4.2, WHITE, 0, 0.65, 0), cbox(1.6, 0.55, 2.2, GLASS, 0, 1.2, -0.2), cbox(1.5, 0.08, 1.7, WHITE, 0, 1.5, -0.2),
    cbox(0.35, 0.16, 0.08, LAMP, -0.6, 0.75, 2.1), cbox(0.35, 0.16, 0.08, LAMP, 0.6, 0.75, 2.1), cbox(0.35, 0.16, 0.08, TAIL, -0.6, 0.78, -2.1), cbox(0.35, 0.16, 0.08, TAIL, 0.6, 0.78, -2.1),
    ...wheels(0.82, [1.3, -1.3], 0.33)] },
  auto: { len: 2.8, r: 1.1, speed: 8, paints: [0xf4c20d], parts: [
    cbox(1.35, 0.7, 2.6, WHITE, 0, 0.75, -0.1), cbox(1.3, 0.75, 1.9, DARK, 0, 1.45, -0.3), cbox(1.36, 0.12, 2.1, 0x1c1c1c, 0, 1.88, -0.25),
    cbox(1.1, 0.6, 0.06, GLASS, 0, 1.45, 0.72), cbox(0.5, 0.5, 0.5, WHITE, 0, 0.75, 1.3), cbox(0.25, 0.14, 0.06, LAMP, 0, 0.95, 1.56),
    cbox(0.22, 0.6, 0.6, TYRE, 0, 0.3, 1.25), ...wheels(0.6, [-0.9], 0.3)] },
  thatch: { len: 3.7, r: 1.4, speed: 13, paints: [0xe53935, 0xf5f5f5, 0x90a4ae, 0x1e88e5, 0xfbc02d, 0x424242], parts: [
    cbox(1.65, 0.62, 3.7, WHITE, 0, 0.66, 0), cbox(1.5, 0.58, 2.3, GLASS, 0, 1.24, -0.45), cbox(1.42, 0.08, 1.9, WHITE, 0, 1.56, -0.55),
    cbox(1.5, 0.5, 0.1, WHITE, 0, 1.2, -1.62),
    cbox(0.32, 0.18, 0.08, LAMP, -0.55, 0.78, 1.85), cbox(0.32, 0.18, 0.08, LAMP, 0.55, 0.78, 1.85), cbox(0.2, 0.34, 0.08, TAIL, -0.68, 0.95, -1.86), cbox(0.2, 0.34, 0.08, TAIL, 0.68, 0.95, -1.86),
    ...wheels(0.78, [1.15, -1.15], 0.32)] },
  tsuv: { len: 4.5, r: 1.6, speed: 12.5, paints: [0xf5f5f5, 0x212121, 0x546e7a, 0x4e342e, 0x283593, 0xb0bec5], parts: [
    cbox(1.9, 0.8, 4.5, WHITE, 0, 0.9, 0), cbox(1.78, 0.68, 2.9, GLASS, 0, 1.62, -0.45), cbox(1.7, 0.1, 2.7, WHITE, 0, 2.0, -0.5),
    cbox(1.92, 0.25, 4.52, DARK, 0, 0.5, 0), cbox(1.3, 0.3, 0.08, DARK, 0, 1.0, 2.26),
    cbox(0.38, 0.2, 0.08, LAMP, -0.68, 1.05, 2.26), cbox(0.38, 0.2, 0.08, LAMP, 0.68, 1.05, 2.26), cbox(0.25, 0.4, 0.08, TAIL, -0.8, 1.15, -2.26), cbox(0.25, 0.4, 0.08, TAIL, 0.8, 1.15, -2.26),
    ...wheels(0.9, [1.4, -1.4], 0.4)] },
  jeep: { len: 3.8, r: 1.5, speed: 11, paints: [0x556b2f, 0x8d6e63, 0xc62828, 0x37474f, 0xf9a825], parts: [
    cbox(1.75, 0.7, 3.7, WHITE, 0, 0.95, 0), cbox(1.45, 0.25, 1.2, WHITE, 0, 1.38, 1.2), cbox(1.6, 0.7, 0.08, GLASS, 0, 1.68, 0.55),
    cbox(1.7, 0.08, 2.1, 0x2b2b2b, 0, 2.08, -0.55), cbox(0.08, 0.75, 0.08, DARK, 0.8, 1.68, -1.55), cbox(0.08, 0.75, 0.08, DARK, -0.8, 1.68, -1.55),
    cbox(1.1, 0.4, 0.08, DARK, 0, 1.05, 1.86), cbox(0.28, 0.28, 0.08, LAMP, -0.65, 1.1, 1.87), cbox(0.28, 0.28, 0.08, LAMP, 0.65, 1.1, 1.87),
    cbox(0.2, 0.24, 0.08, TAIL, -0.72, 1.05, -1.86), cbox(0.2, 0.24, 0.08, TAIL, 0.72, 1.05, -1.86), cbox(0.3, 0.85, 0.85, TYRE, 0, 1.2, -1.98),
    ...wheels(0.9, [1.15, -1.15], 0.45)] },
  van: { len: 4.6, r: 1.6, speed: 11, paints: [0xf5f5f5, 0xeceff1, 0xb0bec5, 0xfff59d, 0x80cbc4], parts: [
    cbox(1.8, 1.7, 4.6, WHITE, 0, 1.3, 0), cbox(1.84, 0.6, 3.6, GLASS, 0, 1.7, -0.2), cbox(1.6, 0.7, 0.08, GLASS, 0, 1.7, 2.3),
    cbox(1.82, 0.22, 4.62, DARK, 0, 0.5, 0), cbox(0.34, 0.2, 0.08, LAMP, -0.62, 0.95, 2.31), cbox(0.34, 0.2, 0.08, LAMP, 0.62, 0.95, 2.31),
    cbox(0.2, 0.5, 0.08, TAIL, -0.78, 1.1, -2.31), cbox(0.2, 0.5, 0.08, TAIL, 0.78, 1.1, -2.31), ...wheels(0.85, [1.5, -1.4], 0.36)] },
  pickup: { len: 3.9, r: 1.4, speed: 10, paints: [0xf5f5f5, 0x1565c0, 0xfdd835, 0xc62828], parts: [
    cbox(1.5, 1.3, 1.3, WHITE, 0, 1.2, 1.25), cbox(1.4, 0.55, 0.08, GLASS, 0, 1.5, 1.92), cbox(1.54, 0.5, 0.8, GLASS, 0, 1.52, 1.3),
    cbox(1.6, 0.12, 2.5, 0x5d5d5d, 0, 0.72, -0.65), cbox(0.08, 0.5, 2.5, WHITE, 0.78, 1.02, -0.65), cbox(0.08, 0.5, 2.5, WHITE, -0.78, 1.02, -0.65), cbox(1.6, 0.5, 0.08, WHITE, 0, 1.02, -1.9),
    cbox(1.2, 0.6, 1.6, 0x9c7b4f, 0, 1.05, -0.8),
    cbox(0.28, 0.18, 0.08, LAMP, -0.5, 0.85, 1.92), cbox(0.28, 0.18, 0.08, LAMP, 0.5, 0.85, 1.92), cbox(0.2, 0.2, 0.08, TAIL, -0.65, 0.7, -1.94), cbox(0.2, 0.2, 0.08, TAIL, 0.65, 0.7, -1.94),
    ...wheels(0.72, [1.2, -1.2], 0.3)] },
  minibus: { len: 6.2, r: 1.9, speed: 10.5, paints: [0xf4f1e6, 0xffb300, 0x26a69a, 0xef5350, 0x5c6bc0], parts: [
    cbox(2.1, 2.1, 6.2, WHITE, 0, 1.55, 0), cbox(2.14, 0.75, 5, GLASS, 0, 2.0, -0.2), cbox(1.9, 0.85, 0.1, GLASS, 0, 1.95, 3.08),
    cbox(2.12, 0.28, 6.22, DARK, 0, 0.6, 0), cbox(2.1, 0.25, 6.2, 0xf4f1e6, 0, 2.72, 0),
    cbox(0.36, 0.22, 0.1, LAMP, -0.7, 0.95, 3.1), cbox(0.36, 0.22, 0.1, LAMP, 0.7, 0.95, 3.1), cbox(0.3, 0.25, 0.1, TAIL, -0.8, 1, -3.1), cbox(0.3, 0.25, 0.1, TAIL, 0.8, 1, -3.1),
    ...wheels(0.98, [2, -1.8], 0.42)] },
  bike: { len: 2, r: 0.7, speed: 14, paints: [0xd32f2f, 0x212121, 0x1976d2, 0xf57c00, 0x455a64], parts: [
    cbox(0.14, 0.62, 0.62, TYRE, 0, 0.31, 0.72), cbox(0.16, 0.62, 0.62, TYRE, 0, 0.31, -0.68), cbox(0.3, 0.3, 0.9, WHITE, 0, 0.78, 0.05),
    cbox(0.26, 0.14, 0.7, 0x1c1c1c, 0, 0.98, -0.4), cbox(0.1, 0.6, 0.1, DARK, 0, 0.8, 0.62), cbox(0.62, 0.06, 0.06, DARK, 0, 1.12, 0.6), cbox(0.16, 0.16, 0.08, LAMP, 0, 0.98, 0.76),
    cbox(0.4, 0.62, 0.26, 0x37474f, 0, 1.45, -0.2), cbox(0.26, 0.26, 0.26, 0x1c1c1c, 0, 1.92, -0.14), cbox(0.14, 0.5, 0.4, 0x263238, 0.2, 0.9, 0), cbox(0.14, 0.5, 0.4, 0x263238, -0.2, 0.9, 0)] },
  scooter: { len: 1.8, r: 0.7, speed: 10, paints: [0xf5f5f5, 0xec407a, 0x26c6da, 0xffca28, 0x8d6e63], parts: [
    cbox(0.14, 0.44, 0.44, TYRE, 0, 0.22, 0.62), cbox(0.16, 0.44, 0.44, TYRE, 0, 0.22, -0.58), cbox(0.42, 0.5, 0.8, WHITE, 0, 0.6, -0.4),
    cbox(0.4, 0.08, 0.5, WHITE, 0, 0.4, 0.15), cbox(0.36, 0.75, 0.1, WHITE, 0, 0.75, 0.5), cbox(0.56, 0.06, 0.06, DARK, 0, 1.15, 0.5), cbox(0.14, 0.14, 0.06, LAMP, 0, 0.95, 0.57),
    cbox(0.38, 0.6, 0.24, 0x6d4c41, 0, 1.3, -0.3), cbox(0.25, 0.25, 0.25, 0xfdd835, 0, 1.75, -0.26), cbox(0.4, 0.12, 0.7, 0x1c1c1c, 0, 0.9, -0.42)] },
};
const COUNTS = TRAFFIC_COUNTS;
export const isTrafficType = (t) => t in MODELS;
const GEO = {};
const geoOf = (type) => (GEO[type] ??= mergeGeometries(MODELS[type].parts));

/** A drivable copy of a traffic vehicle, for a player who has taken one. */
export function makeTrafficCar(type, color) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geoOf(type), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, color })));
  g.rotation.order = 'YXZ';
  g.userData = { wheels: [], len: MODELS[type].len };
  return g;
}

// Join road pieces end to end into long routes a vehicle can follow.
function buildRoutes() {
  const key = (p) => Math.round(p[0] * 2) + ',' + Math.round(p[1] * 2);
  const ends = new Map();
  ROADS.forEach((r, ri) => {
    if (r.cls === 'q') return;
    for (const e of [0, 1]) {
      const k = key(e ? r.pts[r.pts.length - 1] : r.pts[0]);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push([ri, e]);
    }
  });
  const used = new Set(), routes = [];
  const order = ROADS.map((r, i) => i).filter((i) => ROADS[i].cls !== 'q').sort((a, b) => 'tps'.indexOf(ROADS[a].cls) - 'tps'.indexOf(ROADS[b].cls));
  const extend = (pts) => {            // keep adding the road that continues straightest
    for (;;) {
      const n = pts.length, last = pts[n - 1], prev = pts[n - 2];
      const dir = Math.atan2(last[0] - prev[0], last[1] - prev[1]);
      let best = null, bestA = 1.1;
      for (const [ri, e] of ends.get(key(last)) || []) {
        if (used.has(ri)) continue;
        const rp = e ? [...ROADS[ri].pts].reverse() : ROADS[ri].pts;
        const d = Math.atan2(rp[1][0] - rp[0][0], rp[1][1] - rp[0][1]);
        const a = Math.abs(Math.atan2(Math.sin(d - dir), Math.cos(d - dir)));
        if (a < bestA) { bestA = a; best = [ri, rp]; }
      }
      if (!best) return;
      used.add(best[0]);
      pts.push(...best[1].slice(1));
    }
  };
  for (const ri of order) {
    if (used.has(ri)) continue;
    used.add(ri);
    const pts = ROADS[ri].pts.map((p) => p.slice());
    extend(pts);
    pts.reverse(); extend(pts);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    if (cum[cum.length - 1] > 180) routes.push({ pts, cum, len: cum[cum.length - 1] });
  }
  return routes;
}

export function buildTraffic(scene) {
  const routes = buildRoutes();
  const total = routes.reduce((s, r) => s + r.len, 0);
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pickRoute = () => { let t = rnd() * total; for (const r of routes) { if ((t -= r.len) <= 0) return r; } return routes[0]; };
  const vehicles = [], meshes = {};
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  for (const [type, n] of Object.entries(COUNTS)) {
    const M = MODELS[type];
    const mesh = new THREE.InstancedMesh(geoOf(type), mat, n);
    mesh.frustumCulled = false;
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const paint = M.paints[Math.floor(rnd() * M.paints.length)];
      mesh.setColorAt(i, c.set(paint));
      const route = pickRoute();
      vehicles.push({ type, i, id: vehicles.length, paint: '#' + paint.toString(16).padStart(6, '0'), rot: 0, route, phase: rnd() * route.len * 2, speed: M.speed * (0.85 + rnd() * 0.3), r: M.r, x: 0, z: 0 });
    }
    scene.add(mesh);
    meshes[type] = mesh;
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const LANE = 1.35; // keep left, as in India
  const hidden = new Set();   // vehicles a player has driven away
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  function update(now) {
    for (const v of vehicles) {
      if (hidden.has(v.id)) { v.x = v.z = 1e9; meshes[v.type].setMatrixAt(v.i, zero); continue; }
      const { pts, cum, len } = v.route;
      let d = (v.phase + v.speed * now) % (2 * len);
      const back = d > len;
      if (back) d = 2 * len - d;
      let lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
      const a = pts[lo], b = pts[hi], t = (d - cum[lo]) / (cum[hi] - cum[lo] || 1);
      let rot = Math.atan2(b[0] - a[0], b[1] - a[1]);
      if (back) rot += Math.PI;
      v.rot = rot;
      v.x = a[0] + (b[0] - a[0]) * t + Math.cos(rot) * LANE;
      v.z = a[1] + (b[1] - a[1]) * t - Math.sin(rot) * LANE;
      pos.set(v.x, Math.max(heightAt(v.x, v.z), 0.15) + 0.12, v.z);
      m4.compose(pos, q.setFromAxisAngle(up, rot), one);
      meshes[v.type].setMatrixAt(v.i, m4);
    }
    for (const k in meshes) meshes[k].instanceMatrix.needsUpdate = true;
  }
  return { vehicles, routes, hidden, update };
}
