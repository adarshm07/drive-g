// Shared low-poly parts for the player cars: materials, boxes, tyres and wheels.
import * as THREE from 'three';
import { ENV } from './look.js';

export const L = (color, o = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...o });
// shiny paint: picks up the sky reflection (set up in look.js before any car is built)
export const P = (color, o = {}) => new THREE.MeshPhongMaterial({ color, specular: 0x555555, shininess: 70, envMap: ENV.map, reflectivity: 0.18, combine: THREE.MixOperation, ...o });
// lamps are brighter than white, so they stay bright through tone mapping and glow on High
export const lamp = (color, k = 2.2) => { const m = new THREE.MeshBasicMaterial({ color }); m.color.multiplyScalar(k); return m; };
export const TYRE = L(0x1b1b1b), GLASS = L(0x1d2b36, { name: 'glass' }), DARK = L(0x24262b), CHROME = L(0xb9bec4);
export const HEAD = lamp(0xfff3c0), TAIL = lamp(0xd32f2f, 1.8);
export const TYRE_SMOOTH = new THREE.MeshLambertMaterial({ color: 0x1a1a1a, side: THREE.DoubleSide });

export function box(w, h, d, m, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  return mesh;
}

// A round tyre with rounded shoulders, centred on the origin with its axle along x.
// `inner` is the bead radius, where the rim sits.
const TYRE_GEOMETRIES = new Map();
export function tyreGeometry(outer, inner, width, segments = 28) {
  const key = [outer, inner, width, segments].map((v) => v.toFixed(3)).join();
  if (TYRE_GEOMETRIES.has(key)) return TYRE_GEOMETRIES.get(key);
  const hw = width / 2, sh = Math.min(width * 0.28, (outer - inner) * 0.45); // shoulder radius
  const pts = [new THREE.Vector2(inner, -hw * 0.92), new THREE.Vector2(outer - sh * 0.6, -hw)];
  for (let i = 0; i <= 4; i++) {                       // rounded shoulder, sidewall to tread
    const a = -Math.PI / 2 + (i / 4) * (Math.PI / 2);
    pts.push(new THREE.Vector2(outer - sh + Math.cos(a) * sh, -hw + sh + Math.sin(a) * sh));
  }
  for (let i = 0; i <= 4; i++) {                       // tread to the other sidewall
    const a = (i / 4) * (Math.PI / 2);
    pts.push(new THREE.Vector2(outer - sh + Math.cos(a) * sh, hw - sh + Math.sin(a) * sh));
  }
  pts.push(new THREE.Vector2(outer - sh * 0.6, hw), new THREE.Vector2(inner, hw * 0.92));
  const g = new THREE.LatheGeometry(pts, segments);   // lathe spins about y; turn that into x
  g.rotateZ(-Math.PI / 2);
  TYRE_GEOMETRIES.set(key, g);
  return g;
}

/**
 * A wheel on a pivot at its centre, so main.js can spin it about the axle (pivot.rotation.x).
 * Spokes go on the outer face, which is the side `x` points to.
 */
export function wheel(r, x, z, wheels, { width = 0.34, rimRatio = 0.62, segments = 16, tyre = TYRE, rim = CHROME, spoke = DARK, spokes = 5 } = {}) {
  const pivot = new THREE.Group();
  pivot.position.set(x, r, z);
  const rr = r * rimRatio, side = Math.sign(x);
  pivot.add(new THREE.Mesh(tyreGeometry(r, rr, width, segments), tyre));
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr, width * 0.8, segments), rim);
  disc.rotation.z = Math.PI / 2;
  pivot.add(disc);
  for (let i = 0; i < spokes; i++) {
    const s = box(0.04, rr * 1.7, rr * 0.22, spoke, side * width * 0.41, 0, 0);
    s.rotation.x = (i / spokes) * Math.PI;
    pivot.add(s);
  }
  wheels.push(pivot);
  return pivot;
}
