// Shared between the server and the browser client.
// Axes: +x = east, +z = south. One unit is 10 real metres (the map is real Kannur at 1:10).
// The map itself (roads, landmarks, spawn points) is generated from OpenStreetMap by
// scripts/build-map.py into ./map-data.js. Map data (c) OpenStreetMap contributors, ODbL.

import * as MAP from './map-data.js';

export const { BOUNDS, TERRAIN, LANDMARKS, PADDIES, SPAWNS, BEACH_ENTRY, COCONUT_SPOTS } = MAP;

export const WORLD = {
  bounds: BOUNDS,
  water: -0.7,     // water surface height
  roomSize: 8,
};

export const CARS = [
  { id: 'sedan', name: 'Sedan', blurb: 'Fast on tarmac', maxSpeed: 36, accel: 11, turn: 1.9, offroad: 0.5 },
  { id: 'hatch', name: 'Hatchback', blurb: 'Quick and nimble', maxSpeed: 32, accel: 13, turn: 2.3, offroad: 0.55 },
  { id: 'suv', name: 'Open-top 4x4', blurb: 'Goes anywhere', maxSpeed: 28, accel: 10, turn: 2.0, offroad: 0.92 },
];

// Vehicles from the road traffic. Any player can walk up to one and drive it away.
export const TRAFFIC_TYPES = [
  { id: 'bus', name: 'Bus', maxSpeed: 24, accel: 6, turn: 1.25, offroad: 0.4 },
  { id: 'lorry', name: 'Lorry', maxSpeed: 22, accel: 5, turn: 1.3, offroad: 0.5 },
  { id: 'tcar', name: 'Car', maxSpeed: 34, accel: 11, turn: 2.0, offroad: 0.5 },
  { id: 'auto', name: 'Autorickshaw', maxSpeed: 20, accel: 9, turn: 2.7, offroad: 0.6 },
  { id: 'thatch', name: 'Hatchback', maxSpeed: 31, accel: 12, turn: 2.3, offroad: 0.55 },
  { id: 'tsuv', name: 'SUV', maxSpeed: 32, accel: 10, turn: 1.9, offroad: 0.8 },
  { id: 'jeep', name: 'Jeep', maxSpeed: 27, accel: 10, turn: 2.0, offroad: 0.92 },
  { id: 'van', name: 'Van', maxSpeed: 27, accel: 8, turn: 1.7, offroad: 0.5 },
  { id: 'pickup', name: 'Mini truck', maxSpeed: 24, accel: 8, turn: 1.9, offroad: 0.6 },
  { id: 'minibus', name: 'Mini bus', maxSpeed: 25, accel: 7, turn: 1.5, offroad: 0.45 },
  { id: 'bike', name: 'Motorbike', maxSpeed: 30, accel: 14, turn: 2.8, offroad: 0.7 },
  { id: 'scooter', name: 'Scooter', maxSpeed: 22, accel: 11, turn: 2.9, offroad: 0.6 },
];
export const ALL_CARS = [...CARS, ...TRAFFIC_TYPES];
export const TRAFFIC_COUNTS = { bus: 20, lorry: 10, tcar: 16, auto: 22, thatch: 16, tsuv: 10, jeep: 8, van: 8, pickup: 10, minibus: 6, bike: 18, scooter: 16 };
export const TRAFFIC_TOTAL = Object.values(TRAFFIC_COUNTS).reduce((a, b) => a + b, 0);

export const COLORS = ['#e0e0e0', '#c62828', '#1565c0', '#f9a825', '#2e7d32', '#212121', '#ef6c00', '#6a1b9a'];

// Road width by class: t = NH 66 (trunk), p = state highway, s = district road, q = minor road.
export const ROAD_WIDTHS = { t: 8.6, p: 6.4, s: 5.6, q: 4.2 };
export const ROAD_NAMES = { t: 'National highway', p: 'State highway', s: 'District road', q: 'Local road' };

// Round off the corners of a polyline (Chaikin). The ends stay put so junctions still meet.
function smoothLine(pts, rounds = 2) {
  for (let k = 0; k < rounds && pts.length > 2; k++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      if (i > 0) out.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25]);
      if (i < pts.length - 2) out.push([ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

export const ROADS = MAP.ROADS.map((r) => {
  let pts = [];
  for (let i = 0; i < r.p.length; i += 2) pts.push([r.p[i], r.p[i + 1]]);
  pts = smoothLine(pts);
  return { cls: r.c, name: r.n, bridge: !!r.b, width: ROAD_WIDTHS[r.c], pts };
});

export const ISLAND = (() => {
  const pts = [];
  for (let i = 0; i < MAP.ISLAND.length; i += 2) pts.push([MAP.ISLAND[i], MAP.ISLAND[i + 1]]);
  return pts;
})();

/** Points along a polyline, roughly `step` apart (straight segments, so roads follow the map exactly). */
export function samplePath(pts, step = 3) {
  const out = [pts[0].slice()];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}

// ---------- road lookup (spatial hash of points along every road) ----------
const CELL = 16;
const grid = new Map();
const key = (i, j) => i * 100003 + j;
ROADS.forEach((r, ri) => {
  const sm = samplePath(r.pts, 2);
  sm.forEach(([x, z], n) => {
    const a = sm[Math.max(n - 1, 0)], b = sm[Math.min(n + 1, sm.length - 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
    let cell = grid.get(k);
    if (!cell) grid.set(k, (cell = []));
    cell.push(x, z, r.width / 2, ri, (b[0] - a[0]) / l, (b[1] - a[1]) / l);
  });
});

/**
 * Distance from (x, z) to the edge of the nearest road (negative = on the road).
 * Exact up to about 16 units; anything further returns at least that.
 */
export function distToRoad(x, z) {
  return nearestRoad(x, z).edge;
}

export function nearestRoad(x, z) {
  const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
  let best = 99, road = -1;
  for (let i = ci - 1; i <= ci + 1; i++)
    for (let j = cj - 1; j <= cj + 1; j++) {
      const cell = grid.get(key(i, j));
      if (!cell) continue;
      for (let k = 0; k < cell.length; k += 6) {
        const d = Math.hypot(cell[k] - x, cell[k + 1] - z) - cell[k + 2];
        if (d < best) { best = d; road = cell[k + 3]; }
      }
    }
  return { edge: best, road: road >= 0 ? ROADS[road] : null };
}

/**
 * True when (x, z) lies on a different road that crosses or joins road `ri` at an angle
 * (tangent tx, tz). Used to keep lane markings out of junctions.
 */
export function onCrossingRoad(x, z, ri, tx, tz, pad = 0.2) {
  const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
  for (let i = ci - 1; i <= ci + 1; i++)
    for (let j = cj - 1; j <= cj + 1; j++) {
      const cell = grid.get(key(i, j));
      if (!cell) continue;
      for (let k = 0; k < cell.length; k += 6) {
        if (cell[k + 3] === ri) continue;
        if (Math.hypot(cell[k] - x, cell[k + 1] - z) > cell[k + 2] + pad) continue;
        if (Math.abs(tx * cell[k + 5] - tz * cell[k + 4]) > 0.3) return true; // not parallel: a real junction
      }
    }
  return false;
}

// ---------- terrain (loaded by the client from client/assets/terrain.png) ----------
export const SURF = { grass: 0, sand: 80, drivein: 160, paddy: 240 };
let SD = null, SURFACE = null;

/** sd: signed distance to water per pixel (+ land, - water); surface: SURF codes per pixel. */
export function setTerrain(sd, surface) { SD = sd; SURFACE = surface; }
export const terrainReady = () => SD !== null;

/** Signed distance to the nearest water in game units (bilinear). Positive on land. */
export function waterDist(x, z) {
  if (!SD) return 50;
  const { w, h, res, x0, z0 } = TERRAIN;
  const fx = Math.min(w - 1.001, Math.max(0, (x - x0) / res - 0.5));
  const fz = Math.min(h - 1.001, Math.max(0, (z - z0) / res - 0.5));
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
  const a = SD[j * w + i], b = SD[j * w + i + 1], c = SD[(j + 1) * w + i], d = SD[(j + 1) * w + i + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

export function surfaceAt(x, z) {
  if (!SURFACE) return SURF.grass;
  const { w, h, res, x0, z0 } = TERRAIN;
  const i = Math.floor((x - x0) / res), j = Math.floor((z - z0) / res);
  if (i < 0 || j < 0 || i >= w || j >= h) return SURF.grass;
  return SURFACE[j * w + i];
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Terrain height at a point. The water surface is at WORLD.water (-0.7). */
export function heightAt(x, z) {
  const sd = waterDist(x, z);
  if (sd < 0) return Math.max(-4.5, sd * 0.55) - 0.25;
  // flat coastal plain in the west, rolling laterite hills that grow towards the east
  const east = smooth(-350, 520, x);
  const roll = Math.sin(x * 0.009 + Math.cos(z * 0.006) * 2.1) * Math.cos(z * 0.0105 + 0.7);
  const ridge = Math.sin(x * 0.021 + z * 0.013) * Math.cos(z * 0.019 - x * 0.007);
  const hills = (1.2 + 1.2 * roll) * (1 + east * 3.2) + (0.5 + 0.5 * ridge) * east * 3.5;
  return -0.25 + smooth(0, 3, sd) * 0.45 + smooth(6, 90, sd) * hills;
}

export const isWater = (x, z) => waterDist(x, z) < 0;
export const inBeach = (x, z) => surfaceAt(x, z) === SURF.drivein;

/** Somewhere in Kannur town on NH 66, in the left lane (India drives on the left). */
export function spawnPoint() {
  const [x, z, rot] = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
  const o = 2.4; // offset to the left of the direction of travel
  return { x: +(x + Math.cos(rot) * o).toFixed(2), z: +(z - Math.sin(rot) * o).toFixed(2), rot };
}
