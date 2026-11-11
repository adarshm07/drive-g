// An original four-door saloon, built in code so the game ships no third-party car design.
// The body is a side profile extruded across the car with small bevels, so it has flat sides and
// crisp edges; the cabin narrows towards the roof. Front of the car points to +z, ground is y = 0.
import * as THREE from 'three';
import { P, DARK, CHROME, HEAD, TAIL, TYRE_SMOOTH, box, wheel } from './parts.js';

const LEN = 4.6, WIDTH = 1.82, WHEEL_R = 0.34, AXLE = 1.42, TRACK = 0.78;
const GLASS = P(0x16212b, { shininess: 110 });
const ALLOY = P(0xc9ced4, { shininess: 90 });
const ALLOY_DARK = P(0x3a3e44, { shininess: 40 });

// Side profile of the lower body (s along the car, y up), with the two wheel arches cut out.
function hullShape() {
  const s = new THREE.Shape(), a = 0.43, y0 = 0.26, cy = WHEEL_R;
  s.moveTo(-2.25, y0);
  s.lineTo(-AXLE - a, y0);
  s.lineTo(-AXLE - a, cy);
  s.absarc(-AXLE, cy, a, Math.PI, 0, true);
  s.lineTo(-AXLE + a, y0);
  s.lineTo(AXLE - a, y0);
  s.lineTo(AXLE - a, cy);
  s.absarc(AXLE, cy, a, Math.PI, 0, true);
  s.lineTo(AXLE + a, y0);
  s.lineTo(2.2, y0);
  s.lineTo(2.33, 0.34);                                // bumper lip
  s.lineTo(2.36, 0.56);                                // upright bumper face
  s.lineTo(2.32, 0.74);                                // headlamp line
  s.lineTo(2.2, 0.8);                                  // nose edge
  s.lineTo(1.05, 0.96);                                // bonnet up to the scuttle
  s.lineTo(-1.65, 1.0);                                // belt line
  s.lineTo(-2.2, 0.99);                                // boot lid
  s.lineTo(-2.32, 0.93);
  s.lineTo(-2.36, 0.6);                                // upright tail
  s.lineTo(-2.33, 0.34);
  s.lineTo(-2.25, y0);
  return s;
}

// The glasshouse: windscreen, roof line and rear screen, from just below the belt line.
function cabinShape() {
  const s = new THREE.Shape();
  s.moveTo(1.08, 0.9);
  s.lineTo(1.08, 0.97);
  s.lineTo(0.22, 1.4);                                 // windscreen
  s.quadraticCurveTo(-0.3, 1.45, -0.85, 1.41);         // roof
  s.lineTo(-1.7, 1.0);                                 // rear screen
  s.lineTo(-1.7, 0.9);
  return s;
}

// Extrude a side profile across the car and centre it, so profile s -> car z and depth -> car x.
function extrudeSide(shape, width, bevel) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.7,
    bevelSegments: 2, curveSegments: 12,
  });
  g.translate(0, 0, -(width - bevel * 2) / 2);
  g.rotateY(-Math.PI / 2);
  return g;
}

// Pull the sides in above `from`, so the cabin has tumblehome instead of straight walls.
function taper(g, from, to, amount) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = Math.min(1, Math.max(0, (p.getY(i) - from) / (to - from)));
    p.setX(i, p.getX(i) * (1 - amount * t));
  }
  g.computeVertexNormals();
  return g;
}

// Kerala number plate. KL 13 is Kannur's registration code.
let plateTexture;
function plate(x, y, z, rotY) {
  if (!plateTexture) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#f4f4f0'; ctx.fillRect(0, 0, 256, 64);
    ctx.strokeStyle = '#222'; ctx.lineWidth = 4; ctx.strokeRect(3, 3, 250, 58);
    ctx.fillStyle = '#111'; ctx.font = 'bold 40px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('KL 13 K 2026', 128, 34);
    plateTexture = new THREE.CanvasTexture(c);
    plateTexture.colorSpace = THREE.SRGBColorSpace;
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.13), new THREE.MeshLambertMaterial({ map: plateTexture }));
  m.position.set(x, y, z);
  m.rotation.y = rotY;
  return m;
}

export function makeSedan(color) {
  const g = new THREE.Group();
  const paint = P(color, { shininess: 80 });
  const wheels = [];

  g.add(new THREE.Mesh(extrudeSide(hullShape(), WIDTH, 0.04), paint));
  g.add(new THREE.Mesh(taper(extrudeSide(cabinShape(), WIDTH - 0.1, 0.03), 0.95, 1.42, 0.2), GLASS));

  // roof panel in body colour, sitting on the glass
  const roof = new THREE.Shape();
  roof.moveTo(0.3, 1.34);
  roof.lineTo(-1.0, 1.34);
  roof.lineTo(-0.86, 1.425);
  roof.quadraticCurveTo(-0.3, 1.47, 0.2, 1.42);
  roof.lineTo(0.3, 1.34);
  g.add(new THREE.Mesh(extrudeSide(roof, 1.46, 0.015), paint));

  for (const sx of [1, -1]) {
    const pillar = box(0.03, 0.44, 0.11, DARK, sx * 0.79, 1.2, -0.27);  // B-pillar
    pillar.rotation.z = sx * 0.17;
    g.add(pillar);
    g.add(box(0.02, 0.025, 2.7, CHROME, sx * 0.875, 1.0, -0.3));        // window line trim
    g.add(box(0.02, 0.38, 0.012, DARK, sx * 0.915, 0.72, -0.25));       // door shut lines
    g.add(box(0.02, 0.38, 0.012, DARK, sx * 0.915, 0.72, 0.95));
    g.add(box(0.03, 0.035, 0.16, CHROME, sx * 0.92, 0.88, 0.62));       // door handles
    g.add(box(0.03, 0.035, 0.16, CHROME, sx * 0.92, 0.88, -0.62));
    g.add(box(0.04, 0.09, 2.0, DARK, sx * 0.9, 0.3, 0));                // side skirt
    const mirror = box(0.2, 0.11, 0.13, paint, sx * 0.98, 1.06, 0.92);
    mirror.rotation.y = sx * 0.2;
    g.add(mirror);

    // headlamp unit on the upper bumper face: dark housing, two lenses, running-light strip
    const lamp = new THREE.Group();
    lamp.position.set(sx * 0.56, 0.65, 2.34);
    lamp.rotation.set(-0.22, sx * 0.12, 0);
    lamp.add(box(0.5, 0.17, 0.06, DARK, 0, 0, 0));
    lamp.add(box(0.2, 0.12, 0.05, HEAD, sx * 0.1, 0.005, 0.02), box(0.14, 0.1, 0.05, HEAD, -sx * 0.1, 0.005, 0.02));
    lamp.add(box(0.46, 0.022, 0.05, HEAD, 0, -0.07, 0.025));
    g.add(lamp);
    g.add(box(0.12, 0.05, 0.05, HEAD, sx * 0.7, 0.42, 2.37));          // fog lamps

    const tail = new THREE.Group();                                     // tail lamp unit
    tail.position.set(sx * 0.56, 0.8, -2.35);
    tail.add(box(0.52, 0.16, 0.06, DARK, 0, 0, 0), box(0.48, 0.12, 0.06, TAIL, 0, 0, -0.012));
    g.add(tail);
    g.add(box(0.1, 0.05, 0.04, TAIL, sx * 0.75, 0.38, -2.34));         // rear reflectors

    const rims = { width: 0.27, rimRatio: 0.66, segments: 28, tyre: TYRE_SMOOTH, rim: ALLOY_DARK, spoke: ALLOY, spokes: 6 };
    g.add(wheel(WHEEL_R, sx * TRACK, AXLE, wheels, rims), wheel(WHEEL_R, sx * TRACK, -AXLE, wheels, rims));
  }

  // plain slatted grille between the lamps and a lower intake: no badge
  g.add(box(0.56, 0.14, 0.06, DARK, 0, 0.66, 2.35));
  for (const y of [0.63, 0.67, 0.71]) g.add(box(0.52, 0.012, 0.02, CHROME, 0, y, 2.38));
  g.add(box(1.1, 0.08, 0.06, DARK, 0, 0.37, 2.36));
  g.add(box(1.5, 0.1, 0.06, DARK, 0, 0.32, -2.33));                    // rear diffuser
  g.add(plate(0, 0.5, 2.395, 0), plate(0, 0.58, -2.39, Math.PI));

  g.rotation.order = 'YXZ';
  g.userData = { wheels, len: LEN };
  return g;
}
