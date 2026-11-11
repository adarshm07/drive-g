// Water effects: spray droplets thrown up by wheels and feet, and ripple rings on the surface.
// One shared pool each, so any number of cars can splash without allocating per frame.
import * as THREE from 'three';

const DROPS = 600, RINGS = 40, GRAVITY = 9.8;

function dropTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d'), grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(235,248,255,0.7)');
  grad.addColorStop(1, 'rgba(235,248,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

export function createWaterFx(scene, waterY) {
  // ---- spray ----
  const pos = new Float32Array(DROPS * 3), vel = new Float32Array(DROPS * 3), life = new Float32Array(DROPS);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({
    map: dropTexture(), size: 0.32, transparent: true, depthWrite: false, opacity: 0.9,
  }));
  points.frustumCulled = false;
  scene.add(points);
  let next = 0;
  for (let i = 0; i < DROPS; i++) pos[i * 3 + 1] = -1e4; // parked out of sight

  /** Throw `n` droplets from (x, z) at the surface: `fx, fz` is the direction they fly, `power` how hard. */
  function spray(x, z, fx, fz, n, power) {
    for (let k = 0; k < n; k++) {
      const i = next; next = (next + 1) % DROPS;
      const spread = (Math.random() - 0.5) * 1.6;
      pos[i * 3] = x + (Math.random() - 0.5) * 0.3;
      pos[i * 3 + 1] = waterY + 0.05;
      pos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.3;
      vel[i * 3] = (fx + -fz * spread) * power * (0.4 + Math.random() * 0.6);
      vel[i * 3 + 1] = power * (0.6 + Math.random() * 0.9);
      vel[i * 3 + 2] = (fz + fx * spread) * power * (0.4 + Math.random() * 0.6);
      life[i] = 1.4;
    }
  }

  // ---- ripples ----
  const ringGeo = new THREE.RingGeometry(0.85, 1, 32).rotateX(-Math.PI / 2);
  const rings = [];
  for (let i = 0; i < RINGS; i++) {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xeaf6ff, transparent: true, opacity: 0, depthWrite: false }));
    m.visible = false;
    m.userData = { age: 0, max: 1, grow: 1 };
    scene.add(m);
    rings.push(m);
  }
  let nextRing = 0;
  /** A ripple ring at (x, z) that grows to `size` over `max` seconds. */
  function ripple(x, z, size = 3, max = 1.6) {
    const m = rings[nextRing]; nextRing = (nextRing + 1) % RINGS;
    m.position.set(x, waterY + 0.02, z);
    m.userData.age = 0; m.userData.max = max; m.userData.grow = size;
    m.visible = true;
  }

  function update(dt) {
    for (let i = 0; i < DROPS; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      vel[i * 3 + 1] -= GRAVITY * dt;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      if (life[i] <= 0 || (pos[i * 3 + 1] < waterY && vel[i * 3 + 1] < 0)) { life[i] = 0; pos[i * 3 + 1] = -1e4; }
    }
    geo.attributes.position.needsUpdate = true;
    for (const m of rings) {
      if (!m.visible) continue;
      const u = m.userData;
      u.age += dt;
      const t = u.age / u.max;
      if (t >= 1) { m.visible = false; continue; }
      const s = 0.4 + u.grow * Math.sqrt(t);
      m.scale.set(s, 1, s);
      m.material.opacity = 0.55 * (1 - t);
    }
  }

  return { spray, ripple, update };
}
