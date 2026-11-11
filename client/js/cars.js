import * as THREE from 'three';
import { isTrafficType, makeTrafficCar } from './traffic.js';
import { L, P, TYRE, GLASS, DARK, HEAD, TAIL, TYRE_SMOOTH, box, tyreGeometry, wheel } from './parts.js';
import { makeSedan } from './sedan.js';

// A box whose top is narrower and pulled in at the front/back: gives slanted windscreens.
function cabin(w, h, d, front, rear, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) {
      p.setX(i, p.getX(i) * 0.82);
      p.setZ(i, p.getZ(i) > 0 ? p.getZ(i) - front : p.getZ(i) + rear);
    }
  }
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, GLASS);
  mesh.position.set(x, y, z);
  return mesh;
}

// Replace a model's tyre mesh with a clean one of the same size, fitted around the rim.
function refitTyre(pivot, tyreMesh, rimMesh) {
  pivot.updateMatrixWorld(true);
  const toPivot = new THREE.Matrix4().copy(pivot.matrixWorld).invert();
  const local = (o) => {
    const b = new THREE.Box3();
    o.updateMatrixWorld(true);
    const pos = o.geometry.attributes.position, v = new THREE.Vector3();
    const m = new THREE.Matrix4().multiplyMatrices(toPivot, o.matrixWorld);
    for (let i = 0; i < pos.count; i++) b.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m));
    return b;
  };
  const t = local(tyreMesh), tSize = t.getSize(new THREE.Vector3());
  const outer = (tSize.y + tSize.z) / 4;
  let inner = outer * 0.72;
  if (rimMesh) {
    const r = local(rimMesh).getSize(new THREE.Vector3());
    inner = Math.min(outer * 0.92, ((r.y + r.z) / 4) * 1.01);
  }
  const fresh = new THREE.Mesh(tyreGeometry(outer, inner, tSize.x * 0.95), TYRE_SMOOTH);
  fresh.position.x = t.getCenter(new THREE.Vector3()).x;
  tyreMesh.visible = false;
  pivot.add(fresh);
}

// ---------- cars loaded from 3D model files (client/assets/cars/<type>.glb) ----------
// A model replaces the built-in box car of the same type. Materials are restyled by name so the
// body takes the colour the player picked: bodypaint, Window, Glass*, Tires, Alloy, Trim, Headlight*, Brake*.
const MODELS = {};
// e.g. { hatch: { url: '/assets/cars/hatch.glb', length: 3.9 } }. Only use models you have the rights to.
const MODEL_FILES = {};
const STYLE = [
  [/^window/i, P(0x10181f, { shininess: 120 })],
  [/^glass/i, P(0xdfe8ee, { transparent: true, opacity: 0.45, shininess: 120 })],
  [/^tire|^tyre/i, new THREE.MeshLambertMaterial({ color: 0x161616, side: THREE.DoubleSide })],
  [/^alloy/i, P(0xc4c9cf, { shininess: 100 })],
  [/^trim/i, P(0x1b1d21, { shininess: 30 })],
  [/^headlight/i, new THREE.MeshBasicMaterial({ color: 0xfff6d0 })],
  [/^brake/i, new THREE.MeshBasicMaterial({ color: 0xd32f2f })],
];

export async function loadCarModels() {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  await Promise.all(Object.entries(MODEL_FILES).map(async ([type, { url, length }]) => {
    try {
      const gltf = await loader.loadAsync(url);
      const holder = new THREE.Group(), model = gltf.scene;
      holder.add(model);
      // scale to the game's car size, centre it, and sit it on the ground with the front towards +z
      let box3 = new THREE.Box3().setFromObject(model);
      const size = box3.getSize(new THREE.Vector3());
      model.scale.multiplyScalar(length / size.z);
      box3 = new THREE.Box3().setFromObject(model);
      const c = box3.getCenter(new THREE.Vector3());
      model.position.sub(new THREE.Vector3(c.x, box3.min.y, c.z));
      holder.updateMatrixWorld(true);
      const wheels = [];
      model.traverse((o) => {
        if (o.isMesh) {
          o.userData.part = o.material.name;
          const st = STYLE.find(([re]) => re.test(o.material.name));
          if (/^bodypaint/i.test(o.material.name)) o.userData.paint = true;
          else if (st) o.material = st[1];
        }
        if (/tire|tyre|wheel/i.test(o.name) && !wheels.some((w) => w === o.parent)) wheels.push(o);
      });
      // each wheel gets a pivot at its centre so it can spin about the axle
      for (const w of wheels) {
        const parts = [];
        w.traverse((o) => o.isMesh && parts.push(o));
        const tyre = parts.find((o) => /^tire|^tyre/i.test(o.userData.part));
        const rim = parts.find((o) => /^alloy|^rim/i.test(o.userData.part));
        const pivot = new THREE.Group();
        pivot.userData.wheel = true;
        // the rim is the cleanest part of the wheel, so it gives the truest axle centre
        pivot.position.copy(new THREE.Box3().setFromObject(rim || w, true).getCenter(new THREE.Vector3()));
        holder.add(pivot);
        holder.updateMatrixWorld(true);
        pivot.attach(w);
        if (tyre) refitTyre(pivot, tyre, rim);
      }
      holder.userData.len = length;
      MODELS[type] = holder;
    } catch (err) {
      console.warn('Car model not loaded, using the built-in car:', type, err.message);
    }
  }));
}

function fromModel(template, color) {
  const g = template.clone(true);
  const paint = P(color);
  const wheels = [];
  g.traverse((o) => {
    if (o.userData.paint) o.material = paint;
    if (o.userData.wheel) wheels.push(o);
  });
  g.rotation.order = 'YXZ';
  g.userData = { wheels, len: template.userData.len };
  return g;
}

/** Build an original low-poly car. Front of the car points to +z. */
export function makeCar(type, color) {
  if (isTrafficType(type)) return makeTrafficCar(type, color);
  if (MODELS[type]) return fromModel(MODELS[type], color);
  if (type === 'sedan') return makeSedan(color);
  const g = new THREE.Group();
  const paint = L(color);
  const wheels = [];
  let len = 4.4;

  if (type === 'suv') {
    len = 3.9;
    g.add(box(1.85, 0.7, 3.8, paint, 0, 0.95, 0));              // tub
    g.add(box(1.5, 0.28, 1.3, paint, 0, 1.4, 1.2));              // bonnet
    g.add(box(1.3, 0.42, 0.08, DARK, 0, 1.05, 1.91));            // grille
    g.add(box(2.0, 0.22, 0.25, DARK, 0, 0.62, 1.98));            // front bumper
    g.add(box(2.0, 0.22, 0.25, DARK, 0, 0.62, -1.98));
    const ws = box(1.7, 0.75, 0.08, GLASS, 0, 1.7, 0.52);        // upright windscreen
    ws.rotation.x = -0.18;
    g.add(ws);
    g.add(box(0.1, 0.85, 0.1, DARK, 0.85, 1.72, -0.55), box(0.1, 0.85, 0.1, DARK, -0.85, 1.72, -0.55));
    g.add(box(1.8, 0.1, 0.1, DARK, 0, 2.14, -0.55));             // roll bar
    g.add(box(0.55, 0.6, 0.5, DARK, 0.42, 1.45, -0.1), box(0.55, 0.6, 0.5, DARK, -0.42, 1.45, -0.1)); // seats
    for (const sx of [1, -1]) {
      g.add(box(0.3, 0.12, 1.1, DARK, sx * 0.98, 1.02, 1.2), box(0.3, 0.12, 1.1, DARK, sx * 0.98, 1.02, -1.2)); // flares
      g.add(wheel(0.48, sx * 0.98, 1.2, wheels), wheel(0.48, sx * 0.98, -1.2, wheels));
      g.add(box(0.3, 0.3, 0.06, HEAD, sx * 0.72, 1.12, 1.92), box(0.22, 0.26, 0.06, TAIL, sx * 0.78, 1.05, -1.92));
    }
    const spare = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.3, 10), TYRE);
    spare.rotation.x = Math.PI / 2;
    spare.position.set(0, 1.25, -2.08);
    g.add(spare);
  } else {                                                       // hatchback
    len = 3.9;
    const w = 1.75, hz = len / 2;
    g.add(box(w, 0.55, len, paint, 0, 0.62, 0));
    g.add(cabin(w - 0.12, 0.58, 2.55, 0.65, 0.22, 0, 1.18, -0.6));
    g.add(box((w - 0.12) * 0.82, 0.07, 1.68, paint, 0, 1.49, -0.815));
    g.add(box(w * 0.55, 0.16, 0.06, DARK, 0, 0.72, hz + 0.01));  // grille
    g.add(box(w + 0.04, 0.16, 0.2, DARK, 0, 0.42, hz - 0.02), box(w + 0.04, 0.16, 0.2, DARK, 0, 0.42, -hz + 0.02));
    for (const sx of [1, -1]) {
      g.add(wheel(0.33, sx * (w / 2 - 0.05), hz - 0.85, wheels), wheel(0.33, sx * (w / 2 - 0.05), -hz + 0.85, wheels));
      g.add(box(0.36, 0.16, 0.06, HEAD, sx * (w / 2 - 0.25), 0.74, hz + 0.01));
      g.add(box(0.34, 0.16, 0.06, TAIL, sx * (w / 2 - 0.24), 0.76, -hz - 0.01));
    }
  }
  g.rotation.order = 'YXZ';
  g.userData = { wheels, len };
  return g;
}

/** Text sprite, used for player name tags and signboards. */
export function makeLabel(text, { bg = 'rgba(15,61,46,0.85)', fg = '#fff', height = 1 } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = '600 44px system-ui, "Noto Sans Malayalam", sans-serif';
  ctx.font = font;
  c.width = Math.ceil(ctx.measureText(text).width) + 40;
  c.height = 64;
  ctx.font = font;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(0, 0, c.width, c.height, 14);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 20, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  sprite.scale.set((c.width / c.height) * height, height, 1);
  return sprite;
}
