// Shared between the server and the browser client.
// Axes: +x = east, +z = south. One unit is 10 real metres (the map is real Kannur at 1:10).
// The map itself (roads, landmarks, spawn points) is generated from OpenStreetMap by
// scripts/build-map.py into ./map-data.js. Map data (c) OpenStreetMap contributors, ODbL.

import * as MAP from './map-data.js';
import { RAILWAY, STATION, BUS_TERMINAL } from './rail-data.js';

export const { BOUNDS, TERRAIN, LANDMARKS, PADDIES, SPAWNS, BEACH_ENTRY, COCONUT_SPOTS } = MAP;
export { RAILWAY, STATION, BUS_TERMINAL };

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
// Each entry: x, z, half width, road index, tangent x, tangent z, surface height, grade.
// Heights are filled in once the elevation is loaded (setElevation); until then roads are flat.
const CELL = 16, STRIDE = 8;
const grid = new Map();
const key = (i, j) => i * 100003 + j;
const ROAD_SAMPLES = ROADS.map((r, ri) => {
  const sm = samplePath(r.pts, 2), slots = [];
  sm.forEach(([x, z], n) => {
    const a = sm[Math.max(n - 1, 0)], b = sm[Math.min(n + 1, sm.length - 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
    let cell = grid.get(k);
    if (!cell) grid.set(k, (cell = []));
    slots.push([cell, cell.length]);
    cell.push(x, z, r.width / 2, ri, (b[0] - a[0]) / l, (b[1] - a[1]) / l, 0.2, 0);
  });
  return { sm, slots };
});

/**
 * Kannur station, laid out across the line. `a` is distance along the line from STATION (x, z) in
 * its direction; offsets are to the left of that direction, which is the town (east) side here.
 * A road runs close along the west side, so at 1:10 there is only room for the platforms and the
 * building on the town side, where the line is straight from about a = -69 to a = +18.
 */
export const STATION_LAYOUT = {
  a0: -19,                                   // middle of the platforms, on the straight
  westTrack: -2.5, eastTrack: 2.5,           // the double track away from the station
  eastTrackAtStation: 5.1,                   // the east track swings out round the island platform
  island: [-0.8, 3.4, 44],                   // platforms 2 and 3: from, to (offsets), length
  platform1: [6.8, 11, 54],
  building: [11.6, 18.2, 32, -10],           // from, to, length, centre a
  footbridgeA: -2,
  band: [-4, 19.5],                          // the strip kept clear for the station
};

// The railway joins the same grid (road index -1), so it is graded like a road, the land beside it is
// cut or filled to meet it, and nothing gets built on it. Through the station it covers the whole layout.
export const RAIL_PTS = [];
for (let i = 0; i < RAILWAY.line.length; i += 2) RAIL_PTS.push([RAILWAY.line[i], RAILWAY.line[i + 1]]);
{
  const sm = samplePath(RAIL_PTS, 2), slots = [];
  const stx = Math.sin(STATION.rot), stz = Math.cos(STATION.rot), [b0, b1] = STATION_LAYOUT.band;
  sm.forEach(([x, z], n) => {
    const a = sm[Math.max(n - 1, 0)], b = sm[Math.min(n + 1, sm.length - 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, tx = (b[0] - a[0]) / l, tz = (b[1] - a[1]) / l;
    const along = (x - STATION.x) * stx + (z - STATION.z) * stz - STATION_LAYOUT.a0;
    const atStation = Math.abs(along) < 34 && Math.hypot(x - STATION.x, z - STATION.z) < 80;
    // through the station the strip is off-centre: move the sample to its middle (left is (-tz, tx))
    const shift = atStation ? (b0 + b1) / 2 : 0, half = atStation ? (b1 - b0) / 2 : 5;
    const cx = x - tz * shift, cz = z + tx * shift;
    const k = key(Math.floor(cx / CELL), Math.floor(cz / CELL));
    let cell = grid.get(k);
    if (!cell) grid.set(k, (cell = []));
    slots.push([cell, cell.length]);
    cell.push(cx, cz, half, -1, tx, tz, 0.2, 0);
  });
  ROAD_SAMPLES.push({ sm: sm.map(([x, z], n) => [x, z]), slots });
}

/**
 * Distance from (x, z) to the edge of the nearest road (negative = on the road).
 * Exact up to about 16 units; anything further returns at least that.
 */
export function distToRoad(x, z) {
  return nearestRoad(x, z).edge;
}

/** Like distToRoad, but ignoring the railway: for driving, where ballast is rough ground. */
export function distToRoadOnly(x, z) {
  return nearestRoad(x, z, true).edge;
}

/**
 * The nearest road: distance to its edge, the road, and its surface height level with this
 * point (taken from the centreline, so a road is level from edge to edge).
 */
export function nearestRoad(x, z, roadsOnly = false) {
  const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
  let best = 99, bc = null, bk = 0;
  for (let i = ci - 1; i <= ci + 1; i++)
    for (let j = cj - 1; j <= cj + 1; j++) {
      const cell = grid.get(key(i, j));
      if (!cell) continue;
      for (let k = 0; k < cell.length; k += STRIDE) {
        if (roadsOnly && cell[k + 3] < 0) continue;
        const d = Math.hypot(cell[k] - x, cell[k + 1] - z) - cell[k + 2];
        if (d < best) { best = d; bc = cell; bk = k; }
      }
    }
  if (!bc) return { edge: best, road: null, level: 0 };
  const along = (x - bc[bk]) * bc[bk + 4] + (z - bc[bk + 1]) * bc[bk + 5];
  return { edge: best, road: ROADS[bc[bk + 3]] ?? null, rail: bc[bk + 3] < 0, level: bc[bk + 6] + bc[bk + 7] * along };
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
      for (let k = 0; k < cell.length; k += STRIDE) {
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
/** The signed distance to water raster (TERRAIN.w x TERRAIN.h), for the water shader's shorelines. */
export const terrainSD = () => SD;

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
  if (sd < 0) {
    // The bank drops to the waterline (sd = -0.82, unchanged so shorelines stay put), then
    // shelves gently for a few metres of wadeable shallows before falling away to deep water.
    const edge = -0.82, shelf = -6;
    if (sd > edge) return sd * 0.55 - 0.25;
    if (sd > shelf) return WORLD.water + (sd - edge) * 0.2;
    return Math.max(-4.5, WORLD.water + (shelf - edge) * 0.2 + (sd - shelf) * 0.55);
  }
  // Real ground from the elevation raster. Near the coast and the rivers the relief fades out, so
  // beaches and banks stay low and the shorelines stay where the map puts them.
  const land = landHeight(x, z, sd);
  if (!GROUND) return land;
  // Roads run on a smoothed copy of the ground (see setElevation): they climb gently, are level
  // across their width and agree at junctions. Land beside a road is cut or filled to meet it.
  const nr = nearestRoad(x, z);
  if (nr.edge >= 6) return land;
  return nr.level + (land - nr.level) * smooth(0.3, 6, nr.edge);
}

function landHeight(x, z, sd, field = GROUND) {
  const base = -0.25 + smooth(0, 3, sd) * 0.45;
  return field ? base + elevSample(field, x, z) * smooth(1, 14, sd) : base;
}

// ---------- elevation (loaded by the client from client/assets/elevation.png) ----------
// Real heights in metres from open terrain data (scripts/build-elevation.py), one pixel per
// ELEV.res units. Shown 2x taller than life so the hills read at the game's 1:10 scale.
export const ELEV = {
  res: 4, x0: BOUNDS.x0, z0: BOUNDS.z0,
  w: Math.round((BOUNDS.x1 - BOUNDS.x0) / 4), h: Math.round((BOUNDS.z1 - BOUNDS.z0) / 4),
  exaggerate: 2,
};
let GROUND = null, ROAD_LEVEL = null;

// Separable box blur, `passes` times (three passes are close to a Gaussian).
function blur(src, w, h, r, passes) {
  let a = Float32Array.from(src), b = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      let s = 0, n = 0;
      for (let k = Math.max(0, i - r); k <= Math.min(w - 1, i + r); k++) { s += a[j * w + k]; n++; }
      b[j * w + i] = s / n;
    }
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      let s = 0, n = 0;
      for (let k = Math.max(0, j - r); k <= Math.min(h - 1, j + r); k++) { s += b[k * w + i]; n++; }
      a[j * w + i] = s / n;
    }
  }
  return a;
}

/** metres: Float32Array of ELEV.w * ELEV.h real ground heights. */
export function setElevation(metres) {
  const k = ELEV.exaggerate / 10; // metres -> game units (1 unit = 10 m)
  const relief = metres.map((m) => Math.max(0, m - 1.5) * k);
  GROUND = blur(relief, ELEV.w, ELEV.h, 1, 1);             // light smoothing of survey noise
  ROAD_LEVEL = blur(relief, ELEV.w, ELEV.h, 4, 3);         // gentle grades for the roads
  // the height of every road sample along its centreline, and the grade between samples
  for (const { sm, slots } of ROAD_SAMPLES) {
    const y = sm.map(([x, z]) => Math.max(0.15, landHeight(x, z, waterDist(x, z), ROAD_LEVEL)));
    slots.forEach(([cell, k], n) => {
      const a = Math.max(n - 1, 0), b = Math.min(n + 1, sm.length - 1);
      const d = Math.hypot(sm[b][0] - sm[a][0], sm[b][1] - sm[a][1]) || 1;
      cell[k + 6] = y[n];
      cell[k + 7] = (y[b] - y[a]) / d;
    });
  }
}

function elevSample(A, x, z) {
  const { w, h, res, x0, z0 } = ELEV;
  const fx = Math.min(w - 1.001, Math.max(0, (x - x0) / res - 0.5));
  const fz = Math.min(h - 1.001, Math.max(0, (z - z0) / res - 0.5));
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
  const a = A[j * w + i], b = A[j * w + i + 1], c = A[(j + 1) * w + i], d = A[(j + 1) * w + i + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

export const isWater = (x, z) => waterDist(x, z) < 0;
export const inBeach = (x, z) => surfaceAt(x, z) === SURF.drivein;

/** Somewhere in Kannur town on NH 66, in the left lane (India drives on the left). */
export function spawnPoint() {
  const [x, z, rot] = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
  const o = 2.4; // offset to the left of the direction of travel
  return { x: +(x + Math.cos(rot) * o).toFixed(2), z: +(z - Math.sin(rot) * o).toFixed(2), rot };
}
