// Low-poly coconut and areca palms, built in code with vertex colours so each kind is one
// instanced mesh. Coconut palms: a ringed, curving trunk swelling at the base, a crown of long
// arching fronds (a rib with a zig-zag edge for the leaflets), a bunch of coconuts and a dead
// frond or two. Areca palms: a thin straight ringed trunk, a green crownshaft and a small tuft.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const col = (hex) => new THREE.Color(hex);

// A non-indexed geometry from a list of triangles: [[ax, ay, az], [bx, ...], [cx, ...], colour].
function fromTris(tris) {
  const pos = new Float32Array(tris.length * 9), c = new Float32Array(tris.length * 9);
  tris.forEach(([a, b, d, k], i) => {
    pos.set([...a, ...b, ...d], i * 9);
    for (let v = 0; v < 3; v++) c.set([k.r, k.g, k.b], i * 9 + v * 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** A trunk following (lean * t^2, height * t, 0), tapering, with alternating ring shades. */
function trunk({ height, lean, r0, r1, segs = 10, sides = 6, light, dark, flare = 0.4 }) {
  const ring = (t) => {
    const cx = lean * t * t, cy = height * t;
    const r = (r0 + (r1 - r0) * t) * (1 + flare * (1 - t) ** 4);
    return Array.from({ length: sides }, (_, s) => {
      const a = (s / sides) * Math.PI * 2;
      return [cx + Math.cos(a) * r, cy, Math.sin(a) * r];
    });
  };
  const tris = [];
  for (let k = 0; k < segs; k++) {
    const A = ring(k / segs), Bv = ring((k + 1) / segs), shade = k % 2 ? dark : light;
    for (let s = 0; s < sides; s++) {
      const n = (s + 1) % sides;
      tris.push([A[s], Bv[s], Bv[n], shade], [A[s], Bv[n], A[n], shade]);
    }
  }
  return { geo: fromTris(tris), top: [lean, height, 0] };
}

/**
 * One frond from `origin`: it leaves at pitch `p0` (radians above horizontal) and arches down to
 * `p1` at the tip, heading `yaw`. The blade is folded into a shallow V along the rib, with a
 * zig-zag outline so it reads as a row of leaflets.
 */
function frond(origin, { len, width, p0, p1, yaw, base, tip, segs = 7, fold = 0.35 }) {
  const side = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const nodes = [];
  let p = [...origin];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, pitch = p0 + (p1 - p0) * t ** 1.3;
    let w = width * Math.sin(Math.PI * Math.min(1, 0.12 + t * 0.95));
    if (i % 2) w *= 0.6;                                   // zig-zag edge: the leaflets
    const drop = w * fold;
    nodes.push({
      c: [...p],
      l: [p[0] + side[0] * w / 2, p[1] - drop, p[2] + side[2] * w / 2],
      r: [p[0] - side[0] * w / 2, p[1] - drop, p[2] - side[2] * w / 2],
      k: base.clone().lerp(tip, t),
    });
    const step = len / segs;
    p = [p[0] + Math.cos(pitch) * Math.sin(yaw) * step, p[1] + Math.sin(pitch) * step, p[2] + Math.cos(pitch) * Math.cos(yaw) * step];
  }
  const tris = [];
  for (let i = 0; i < segs; i++) {
    const a = nodes[i], b = nodes[i + 1];
    tris.push([a.c, a.l, b.l, a.k], [a.c, b.l, b.c, a.k], [a.c, b.r, a.r, a.k], [a.c, b.c, b.r, a.k]);
  }
  return fromTris(tris);
}

function ball(x, y, z, r, k) {
  const g = new THREE.IcosahedronGeometry(r, 0).translate(x, y, z); // already non-indexed
  const c = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < c.length; i += 3) c.set([k.r, k.g, k.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  return g;
}

function finish(parts) {
  const g = mergeGeometries(parts);
  g.computeVertexNormals();
  return g;
}

// Deterministic jitter so every build of the world looks the same.
function jitter(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * Coconut palm, variant 0..2: upright, leaning, strongly curved. About 7-9 units tall.
 * `far` builds the cheap version for palms away from the camera: same outline, fewer and
 * coarser fronds, no coconuts (about a fifth of the triangles).
 */
export function coconutPalm(variant = 0, far = false) {
  const shape = [
    { height: 8.4, lean: 0.5 },
    { height: 7.6, lean: 1.5 },
    { height: 6.8, lean: 2.6 },
  ][variant % 3];
  const rnd = jitter(17 + variant * 101);
  const t = trunk({ ...shape, r0: 0.22, r1: 0.14, segs: far ? 6 : 12, sides: far ? 5 : 6, light: col(0x9a8a74), dark: col(0x7d6e5b), flare: 0.6 });
  const [tx, ty, tz] = t.top;
  const parts = [t.geo];
  const green = col(0x3f8f3a), young = col(0x6fae3e), tipCol = col(0x8cb84a), dead = col(0x9c7a45), deadTip = col(0xb89a5e);
  // crown: an inner ring of young fronds reaching up, an outer ring arching well down
  const N = far ? 8 : 16;
  for (let k = 0; k < N; k++) {
    const outer = far ? k % 4 !== 1 : k % 2 === 0;
    const yaw = (k / N) * Math.PI * 2 + rnd() * 0.3;
    parts.push(frond([tx, ty, tz], {
      len: outer ? 5.4 + rnd() * 0.8 : 4.4 + rnd() * 0.6,
      width: outer ? 0.85 : 0.75,
      p0: outer ? 0.55 + rnd() * 0.2 : 1.05 + rnd() * 0.2,
      p1: outer ? -1.35 - rnd() * 0.25 : -0.6 - rnd() * 0.3,
      yaw, base: outer ? green : young, tip: tipCol, segs: far ? 4 : 10, fold: 0.45,
    }));
  }
  // a dead frond or two hanging against the trunk
  for (let k = 0; k < (far ? 1 : 2); k++) {
    parts.push(frond([tx, ty - 0.15, tz], { len: 3.4, width: 0.38, p0: -1.0, p1: -1.5, yaw: rnd() * 6.28, base: dead, tip: deadTip, segs: far ? 3 : 6, fold: 0.3 }));
  }
  if (far) return finish(parts);
  // a bunch of coconuts just under the crown
  const nut = col(0x6f8f2f), ripe = col(0x9c7a3a);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + rnd() * 0.4, r = 0.24 + rnd() * 0.06;
    parts.push(ball(tx + Math.cos(a) * r, ty - 0.3 - rnd() * 0.25, tz + Math.sin(a) * r, 0.17, k % 3 ? nut : ripe));
  }
  return finish(parts);
}

/** Areca (betel nut) palm: thin, straight and tall, with a green crownshaft and a small tuft. */
export function arecaPalm(far = false) {
  const rnd = jitter(4242);
  const t = trunk({ height: 9, lean: 0.15, r0: 0.11, r1: 0.08, segs: far ? 4 : 14, sides: far ? 4 : 5, light: col(0xa7a297), dark: col(0x8e897e), flare: 0.25 });
  const [tx, ty, tz] = t.top;
  const shaft = trunk({ height: 0.9, lean: 0, r0: 0.11, r1: 0.1, segs: 1, sides: 5, light: col(0x6fae3e), dark: col(0x6fae3e), flare: 0 });
  shaft.geo.translate(tx, ty, tz);
  const parts = [t.geo, shaft.geo];
  const green = col(0x3f8a3c), tipCol = col(0x7fae46);
  const n = far ? 5 : 7;
  for (let k = 0; k < n; k++) {
    parts.push(frond([tx, ty + 0.9, tz], {
      len: 2.2 + rnd() * 0.4, width: 0.7, p0: 1.0 + rnd() * 0.3, p1: -0.6 - rnd() * 0.4,
      yaw: (k / n) * Math.PI * 2 + rnd() * 0.3, base: green, tip: tipCol, segs: far ? 3 : 6,
    }));
  }
  return finish(parts);
}

/** Material for the palms: vertex colours, flat shaded, both sides of the fronds lit. */
export const palmMaterial = () => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });

/**
 * Instances with two levels of detail: the detailed model near the camera, the cheap one further
 * away. Returns update(cameraPosition), cheap to call every frame: it only reshuffles the
 * instances after the camera has moved a few units.
 */
export function lodInstances(scene, near, far, material, matrices, { range = 150, step = 8 } = {}) {
  const hi = new THREE.InstancedMesh(near, material, matrices.length);
  const lo = new THREE.InstancedMesh(far, material, matrices.length);
  hi.frustumCulled = lo.frustumCulled = false; // the visible set changes; cheaper than refitting bounds
  hi.count = 0;
  matrices.forEach((m, i) => lo.setMatrixAt(i, m));
  scene.add(hi, lo);
  const xs = matrices.map((m) => m.elements[12]), zs = matrices.map((m) => m.elements[14]);
  let lx = Infinity, lz = Infinity;
  return (cam) => {
    if (Math.hypot(cam.x - lx, cam.z - lz) < step) return;
    lx = cam.x; lz = cam.z;
    let h = 0, l = 0;
    for (let i = 0; i < matrices.length; i++) {
      if (Math.hypot(xs[i] - lx, zs[i] - lz) < range) hi.setMatrixAt(h++, matrices[i]);
      else lo.setMatrixAt(l++, matrices[i]);
    }
    hi.count = h; lo.count = l;
    hi.instanceMatrix.needsUpdate = lo.instanceMatrix.needsUpdate = true;
  };
}
