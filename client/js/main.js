import * as THREE from 'three';
import { CARS, ALL_CARS, COLORS, LANDMARKS, ROADS, WORLD, BOUNDS, TERRAIN, SURF, heightAt, distToRoad, inBeach, spawnPoint, setTerrain, setElevation, ELEV, distToRoadOnly, RAILWAY } from '/shared/world.js';
import { makeCar, makeLabel, loadCarModels } from './cars.js';
import { buildWorld } from './scene.js';
import { makeKeeper } from './shops.js';
import { buildTraffic } from './traffic.js';
import { createWaterFx } from './splash.js';
import { setupLook, reflective } from './look.js';
import { QUALITY_ID, QUALITY_LEVELS, setQuality, TIME_ID, TIME_LEVELS, setTime } from './quality.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---------- renderer and world ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: true });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 900);
const view = setupLook(renderer, scene, camera); // sky, sun, shadows, tone mapping, glow
const waterFx = createWaterFx(scene, WORLD.water);

// The terrain (coastline, rivers, beaches) is a small raster built from OpenStreetMap data, and the
// hills come from a second raster of real ground heights. Both are read as raw pixel values.
async function loadRaster(url, w, h) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not load the map');
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0);
  return cx.getImageData(0, 0, w, h).data;
}
let terrainPx; // kept for drawing the minimap
{
  const [px, ev] = await Promise.all([
    loadRaster('/assets/terrain.png', TERRAIN.w, TERRAIN.h),
    loadRaster('/assets/elevation.png', ELEV.w, ELEV.h),
  ]);
  const sd = new Float32Array(TERRAIN.w * TERRAIN.h), surf = new Uint8Array(TERRAIN.w * TERRAIN.h);
  for (let i = 0; i < sd.length; i++) {
    sd[i] = (px[i * 4] / 255) * 2 * TERRAIN.sdRange - TERRAIN.sdRange;
    surf[i] = px[i * 4 + 1];
  }
  setTerrain(sd, surf);
  terrainPx = px;
  const metres = new Float32Array(ELEV.w * ELEV.h);
  for (let i = 0; i < metres.length; i++) metres[i] = (ev[i * 4] * 256 + ev[i * 4 + 1]) / 10 - 100;
  setElevation(metres);
}
const world = buildWorld(scene);
const traffic = buildTraffic(scene); // buses, lorries, cars and autos, the same for every player
// shadows on everything, and the sky reflected in glass; new cars and people are picked up as they appear
function finishLook() {
  view.applyShadows();
  scene.traverse((o) => {
    const m = o.material;
    if (m && !Array.isArray(m) && m.name === 'glass' && !m.envMap) reflective(m, 0.3);
  });
}
finishLook();
setInterval(finishLook, 2000);
await loadCarModels(); // real 3D car models where a file exists; box cars otherwise

// Colliders in a coarse grid so the car only checks the ones nearby.
const colGrid = new Map();
const CG = 12, cgKey = (i, j) => i * 100003 + j;
for (const c of world.colliders) {
  const k = cgKey(Math.floor(c.x / CG), Math.floor(c.z / CG));
  if (!colGrid.has(k)) colGrid.set(k, []);
  colGrid.get(k).push(c);
}
function* nearColliders(x, z) {
  const ci = Math.floor(x / CG), cj = Math.floor(z / CG);
  for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
    const list = colGrid.get(cgKey(i, j));
    if (list) yield* list;
  }
}
function resize() {
  view.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- state ----------
let token = store.get('kd_token');
let profile = null;
let mode = 'menu';
let socket = null;
let myId = null;
const sel = {
  car: CARS.some((c) => c.id === store.get('kd_car')) ? store.get('kd_car') : CARS[0].id,
  color: COLORS.includes(store.get('kd_color')) ? store.get('kd_color') : COLORS[1],
};
const me = { ...spawnPoint(), speed: 0, group: null, spec: CARS[0], foot: false, avatar: null, car: null, boostUntil: 0, carType: 'sedan', taken: -1 };
const stats = { coconuts: 0, distance: 0, discovered: new Set() };
const remotes = new Map();   // id -> { group, name, color, x, z, rot, tx, tz, trot, speed }
const coconuts = new Map();  // id -> mesh
const pending = new Set();
const input = { up: false, down: false, left: false, right: false, brake: false, run: false };

// The vehicle you are driving: your garage car, or one taken from the road traffic.
function setDriveModel(type, color) {
  if (me.group) scene.remove(me.group);
  me.carType = type;
  me.spec = ALL_CARS.find((c) => c.id === type);
  me.group = makeCar(type, color);
  scene.add(me.group);
}
// Traffic vehicles someone is driving are hidden from the traffic for everyone.
function syncTaken() {
  traffic.hidden.clear();
  if (me.taken >= 0) traffic.hidden.add(me.taken);
  remotes.forEach((r) => { if (r.taken >= 0) traffic.hidden.add(r.taken); });
}

function setMyCar() {
  if (me.group) scene.remove(me.group);
  setDriveModel(sel.car, sel.color);
  me.taken = -1;
  if (me.avatar) scene.remove(me.avatar);
  me.avatar = makeKeeper(0, sel.color);   // you, when you get out of the car
  me.avatar.visible = false;
  scene.add(me.avatar);
}
setMyCar();

// ---------- API ----------
async function api(path, body) {
  const res = await fetch('/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Something went wrong. Try again.');
  return json;
}

// ---------- menu ----------
function renderWho() {
  $('who').innerHTML = '';
  if (profile) {
    const p = document.createElement('p');
    p.textContent = `Driving as ${profile.username}. Your progress is saved.`;
    $('who').append(p);
  } else {
    const inp = document.createElement('input');
    inp.id = 'guestName';
    inp.maxLength = 16;
    inp.placeholder = 'Your name';
    inp.setAttribute('aria-label', 'Your name');
    inp.value = store.get('kd_name') || '';
    inp.oninput = () => store.set('kd_name', inp.value);
    $('who').append(inp);
  }
  $('auth').hidden = !!profile;
  $('account').hidden = !profile;
  $('acctTitle').textContent = profile ? 'Your account' : 'Save your progress';
  if (profile) {
    $('account').innerHTML = '';
    const p = document.createElement('p');
    p.textContent = `${profile.username}: ${profile.coconuts} coconuts, ${(profile.distance / 1000).toFixed(1)} km, ${profile.discovered.length}/${LANDMARKS.length} places`;
    const out = document.createElement('button');
    out.textContent = 'Log out';
    out.onclick = async () => {
      await api('/logout', {}).catch(() => {});
      token = null; profile = null; store.set('kd_token', null);
      renderWho();
    };
    $('account').append(p, out);
  }
}

// graphics quality picker in the Garage
{
  for (const [row, levels, current, set] of [[$('quality'), QUALITY_LEVELS, QUALITY_ID, setQuality], [$('timeOfDay'), TIME_LEVELS, TIME_ID, setTime]]) {
    for (const q of levels) {
      const b = document.createElement('button');
      b.textContent = q.name;
      b.className = q.id === current ? 'on' : '';
      b.setAttribute('aria-pressed', String(q.id === current));
      b.onclick = () => set(q.id);
      row.append(b);
    }
  }
}
const groundAt = (x, z) => heightAt(x, z);

function renderGarage() {
  $('cars').innerHTML = '';
  for (const c of CARS) {
    const b = document.createElement('button');
    b.className = c.id === sel.car ? 'on' : '';
    b.setAttribute('aria-pressed', c.id === sel.car);
    const bar = (v) => `<div class="bar"><i style="width:${Math.round(v * 100)}%"></i></div>`;
    b.innerHTML = `<b>${c.name}</b><small>${c.blurb}</small><div class="bars" title="Speed, handling, off-road">${bar(c.maxSpeed / 36)}${bar(c.turn / 2.3)}${bar(c.offroad)}</div>`;
    b.onclick = () => { sel.car = c.id; store.set('kd_car', c.id); setMyCar(); renderGarage(); };
    $('cars').append(b);
  }
  $('colors').innerHTML = '';
  for (const col of COLORS) {
    const b = document.createElement('button');
    b.style.background = col;
    b.className = col === sel.color ? 'on' : '';
    b.setAttribute('aria-label', 'Colour ' + col);
    b.onclick = () => { sel.color = col; store.set('kd_color', col); setMyCar(); renderGarage(); };
    $('colors').append(b);
  }
}

let boardData = null, boardKey = 'coconuts';
function renderBoard() {
  const ol = $('board');
  ol.innerHTML = '';
  const rows = boardData?.[boardKey] || [];
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = boardData ? 'No scores yet. Create an account to be first.' : 'Loading…';
    ol.append(li);
  }
  rows.forEach((r, i) => {
    const li = document.createElement('li');
    const a = document.createElement('span'), b = document.createElement('span');
    a.textContent = `${i + 1}. ${r.username}`;
    b.textContent = boardKey === 'distance' ? (r.value / 1000).toFixed(1) + ' km' : boardKey === 'places' ? `${r.value}/${boardData.totalPlaces}` : r.value;
    li.append(a, b);
    ol.append(li);
  });
}
async function loadBoard() {
  try { boardData = await api('/leaderboard'); } catch { boardData = {}; }
  renderBoard();
}
$('boardTabs').onclick = (e) => {
  const k = e.target.dataset?.k;
  if (!k) return;
  boardKey = k;
  [...$('boardTabs').children].forEach((b) => b.classList.toggle('on', b.dataset.k === k));
  renderBoard();
};

$('auth').onsubmit = async (e) => {
  e.preventDefault();
  $('authError').textContent = '';
  try {
    const res = await api('/' + (e.submitter?.dataset.mode || 'login'), { username: $('user').value.trim(), password: $('pass').value });
    token = res.token; profile = res.profile; store.set('kd_token', token);
    $('pass').value = '';
    renderWho();
  } catch (err) { $('authError').textContent = err.message; }
};

function showMenu() {
  mode = 'menu';
  if (socket) { socket.disconnect(); socket = null; }
  clearRoom();
  Object.assign(me, spawnPoint(), { speed: 0, foot: false });
  me.avatar.visible = false;
  setMyCar(); syncTaken();
  closeDialog();
  $('hud').hidden = true;
  $('menu').hidden = false;
  $('play').disabled = false;
  $('play').textContent = 'Start driving';
  if (token) api('/me').then((r) => { profile = r.profile; renderWho(); }).catch(() => { token = null; profile = null; store.set('kd_token', null); renderWho(); });
  renderWho(); renderGarage(); loadBoard();
}
$('toMenu').onclick = showMenu;

// ---------- multiplayer ----------
function clearRoom() {
  remotes.forEach((r) => scene.remove(r.group, r.avatar));
  remotes.clear();
  coconuts.forEach((m) => scene.remove(m));
  coconuts.clear();
  pending.clear();
}

// A player on foot leaves their car parked where they got out; the name tag follows the person.
function setRemoteFoot(r, foot) {
  if (r.foot === foot) return;
  r.foot = foot;
  r.avatar.visible = foot;
  (foot ? r.avatar : r.group).add(r.tag);
  r.tag.position.y = foot ? 2.5 : 3.2;
}

function addRemote(p) {
  if (remotes.has(p.id)) scene.remove(remotes.get(p.id).group, remotes.get(p.id).avatar);
  const group = makeCar(p.car, p.color);
  const tag = makeLabel(p.name, { height: 0.8 });
  tag.position.y = 3.2;
  group.add(tag);
  group.position.set(p.x, 0, p.z);
  scene.add(group);
  const avatar = makeKeeper(0, p.color);
  avatar.visible = false;
  scene.add(avatar);
  const r = { group, avatar, tag, foot: false, taken: p.taken ?? -1, carType: p.car, name: p.name, color: p.color, x: p.x, z: p.z, rot: p.rot, tx: p.x, tz: p.z, trot: p.rot, speed: 0 };
  remotes.set(p.id, r);
  setRemoteFoot(r, !!p.foot);
  syncTaken();
  renderPlayers();
}

const cocoGeo = new THREE.IcosahedronGeometry(0.62, 1);
const cocoMat = new THREE.MeshLambertMaterial({ color: 0x7cb342, flatShading: true });
function addCoconut(c) {
  const m = new THREE.Mesh(cocoGeo, cocoMat);
  m.scale.y = 1.2;
  m.position.set(c.x, 1.4, c.z);
  scene.add(m);
  coconuts.set(c.id, m);
}

function applyStats(s) {
  if (s.coconuts != null) stats.coconuts = s.coconuts;
  if (s.distance != null) stats.distance = s.distance;
  if (s.discovered) stats.discovered = new Set(s.discovered);
  $('sCoco').textContent = stats.coconuts;
  $('sPlaces').textContent = `${stats.discovered.size}/${LANDMARKS.length}`;
  world.beacons.forEach((b, id) => { b.visible = !stats.discovered.has(id); });
}

function renderPlayers() {
  const ul = $('players');
  ul.innerHTML = '';
  const add = (name, color) => {
    const li = document.createElement('li'), dot = document.createElement('i');
    dot.style.background = color;
    li.append(dot, document.createTextNode(name));
    ul.append(li);
  };
  add('You', sel.color);
  remotes.forEach((r) => add(r.name, r.color));
}

function startGame() {
  $('menuError').textContent = '';
  $('play').disabled = true;
  $('play').textContent = 'Finding a room…';
  audio(); engineStart();
  socket = io({ auth: { token } });
  socket.on('connect', () => {
    socket.emit('join', { name: $('guestName')?.value, car: sel.car, color: sel.color }, (res) => {
      myId = res.id;
      clearRoom();
      Object.assign(me, res.spawn, { speed: 0, foot: false });
      me.avatar.visible = false;
      setMyCar();
      res.players.forEach(addRemote);
      res.coconuts.forEach(addCoconut);
      applyStats(res.stats);
      renderPlayers();
      if (mode !== 'play') {
        mode = 'play';
        $('menu').hidden = true;
        $('hud').hidden = false;
        toast('Welcome to Kannur', 'Follow the yellow light beams to find places.');
      }
    });
  });
  socket.on('connect_error', () => {
    if (mode === 'menu') {
      $('menuError').textContent = 'Could not reach the game server. Check your connection and try again.';
      $('play').disabled = false;
      $('play').textContent = 'Start driving';
      socket.disconnect(); socket = null;
    }
  });
  socket.on('disconnect', (why) => { if (mode === 'play' && why !== 'io client disconnect') toast('Connection lost', 'Trying to reconnect…'); });
  socket.on('playerJoined', (p) => { addRemote(p); toast(null, `${p.name} joined`); });
  socket.on('playerLeft', (id) => {
    const r = remotes.get(id);
    if (!r) return;
    scene.remove(r.group, r.avatar); remotes.delete(id); renderPlayers(); syncTaken();
  });
  socket.on('state', (list) => {
    for (const [id, x, z, rot, speed, foot] of list) {
      const r = remotes.get(id);
      if (!r) continue;
      Object.assign(r, { tx: x, tz: z, trot: rot, speed });
      setRemoteFoot(r, foot === 1);
    }
  });
  socket.on('coconutGone', ({ id, by }) => {
    const m = coconuts.get(id);
    if (m) scene.remove(m);
    coconuts.delete(id); pending.delete(id);
    if (by === myId) beep(880, 0.12, 'triangle');
  });
  socket.on('coconutSpawn', addCoconut);
  socket.on('stats', applyStats);
  socket.on('discovered', ({ id, discovered }) => {
    const lm = LANDMARKS.find((l) => l.id === id);
    applyStats({ discovered });
    toast(lm.name, 'Place discovered', lm.ml);
    beep(660, 0.15, 'triangle'); setTimeout(() => beep(990, 0.25, 'triangle'), 140);
  });
  socket.on('notice', (text) => toast(null, text));
  socket.on('chat', ({ id, name, text }) => say(id, name, text));
  socket.on('playerCar', ({ id, car, color, taken }) => {
    const r = remotes.get(id);
    if (!r) return;
    const old = r.group, group = makeCar(car, color);
    group.position.copy(old.position);
    group.rotation.y = old.rotation.y;
    scene.remove(old);
    scene.add(group);
    Object.assign(r, { group, color, taken, carType: car });
    if (!r.foot) { group.add(r.tag); r.tag.position.y = Math.max(3.2, car === 'bus' ? 4.4 : 3.2); }
    syncTaken(); renderPlayers();
  });
  socket.on('honk', (id) => {
    const r = remotes.get(id);
    if (r) honkSound(Math.max(0, 1 - Math.hypot(r.x - me.x, r.z - me.z) / 120), r.carType);
  });
}
$('play').onclick = startGame;

// ---------- sound ----------
let actx = null;
function audio() {
  try { actx ??= new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch { /* no audio */ }
  return actx;
}
function beep(freq, dur, type = 'square', vol = 0.12) {
  const a = audio();
  if (!a || vol <= 0) return;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
  o.connect(g).connect(a.destination);
  o.start(); o.stop(a.currentTime + dur);
}
// Horns: air horn for buses and lorries, a sharp beep for two- and three-wheelers, twin-tone for cars.
function tone(freqs, dur, type, vol, cutoff) {
  const a = audio();
  if (!a || vol < 0.002) return; // too far away to hear
  const lp = a.createBiquadFilter(), g = a.createGain(), t0 = a.currentTime;
  lp.type = 'lowpass'; lp.frequency.value = cutoff;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.03);
  g.gain.setValueAtTime(vol, t0 + dur - 0.08);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  lp.connect(g).connect(a.destination);
  for (const f of freqs) { const o = a.createOscillator(); o.type = type; o.frequency.value = f; o.connect(lp); o.start(t0); o.stop(t0 + dur); }
}
const HEAVY = ['bus', 'lorry', 'minibus'], LIGHT = ['auto', 'bike', 'scooter'];
function honkSound(vol = 1, type = me.carType) {
  if (HEAVY.includes(type)) tone([233, 277, 349], 0.8, 'sawtooth', 0.09 * vol, 1400);
  else if (LIGHT.includes(type)) tone([760, 770], 0.28, 'square', 0.05 * vol, 2600);
  else tone([420, 525], 0.42, 'square', 0.06 * vol, 2200);
}

// Engine: three oscillators through a soft clipper and a low-pass filter, with gear changes,
// plus filtered noise for tyres and wind. Pitch and tone follow speed, throttle and vehicle type.
const ENGINE = { bus: 27, lorry: 25, minibus: 31, van: 38, pickup: 40, jeep: 36, tsuv: 38, suv: 36, auto: 62, bike: 66, scooter: 74 };
let eng = null;
function engineStart() {
  const a = audio();
  if (!a || eng) return;
  const mk = (type) => { const o = a.createOscillator(); o.type = type; o.start(); return o; };
  const o1 = mk('sawtooth'), o2 = mk('sawtooth'), sub = mk('triangle');
  const shaper = a.createWaveShaper(), curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) curve[i] = Math.tanh(((i / 255) * 2 - 1) * 2.4);
  shaper.curve = curve;
  const mix = a.createGain(); mix.gain.value = 0.5;
  const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.5;
  const out = a.createGain(); out.gain.value = 0;
  const subG = a.createGain(); subG.gain.value = 0.9;
  o1.connect(mix); o2.connect(mix); sub.connect(subG).connect(mix);
  mix.connect(shaper).connect(lp).connect(out).connect(a.destination);
  // single-cylinder "putt-putt" for autos and two-wheelers
  const pulse = mk('square'), pulseG = a.createGain(); pulseG.gain.value = 0;
  pulse.connect(pulseG).connect(out.gain);
  const buf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const noise = a.createBufferSource(); noise.buffer = buf; noise.loop = true; noise.start();
  const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.6;
  const noiseG = a.createGain(); noiseG.gain.value = 0;
  noise.connect(bp).connect(noiseG).connect(a.destination);
  eng = { a, o1, o2, sub, lp, out, pulse, pulseG, bp, noiseG, rpm: 0.1, gear: 0 };
}
function engineUpdate(dt) {
  if (!eng) return;
  const on = mode === 'play' && !me.foot, t = eng.a.currentTime;
  const sp = Math.abs(me.speed), r = Math.min(1, sp / me.spec.maxSpeed);
  const throttle = input.up ? 1 : input.down ? 0.35 : 0;
  // five gears, with a little hysteresis so it does not hunt between two
  const want = Math.max(0, Math.min(4, Math.floor(r * 5 + (r * 5 > eng.gear + 1 ? 0 : -0.12))));
  if (want !== eng.gear) { if (want > eng.gear) eng.rpm *= 0.7; eng.gear = want; } // revs drop on the upshift
  const inGear = Math.min(1, Math.max(0, r * 5 - eng.gear));
  const target = sp < 0.4 ? 0.1 + throttle * 0.18 : 0.28 + inGear * 0.62 + throttle * 0.06;
  eng.rpm += (target - eng.rpm) * Math.min(1, dt * 5);
  const base = ENGINE[me.carType] ?? 44, f = base * (1 + eng.rpm * 2.4);
  const light = LIGHT.includes(me.carType);
  eng.o1.frequency.setTargetAtTime(f, t, 0.03);
  eng.o2.frequency.setTargetAtTime(f * 1.5 + 1.7, t, 0.03);
  eng.sub.frequency.setTargetAtTime(f / 2, t, 0.03);
  eng.pulse.frequency.setTargetAtTime(f / 4, t, 0.03);
  eng.lp.frequency.setTargetAtTime(260 + eng.rpm * 1500 + throttle * 900, t, 0.05);
  const vol = on ? 0.035 + throttle * 0.045 + eng.rpm * 0.02 : 0;
  eng.out.gain.setTargetAtTime(vol, t, 0.08);
  eng.pulseG.gain.setTargetAtTime(on && light ? vol * 0.6 : 0, t, 0.08);
  eng.bp.frequency.setTargetAtTime(450 + r * 1100, t, 0.1);
  eng.noiseG.gain.setTargetAtTime(on ? r * r * 0.07 : 0, t, 0.15);
}
let lastHonk = 0;
function honk() {
  if (mode !== 'play' || performance.now() - lastHonk < 600) return;
  lastHonk = performance.now();
  honkSound();
  socket?.emit('honk');
}

// ---------- toasts ----------
function toast(title, text, ml) {
  const el = document.createElement('div');
  el.className = 'toast';
  if (title) { const b = document.createElement('b'); b.textContent = title; el.append(b); }
  if (ml) { const s = document.createElement('small'); s.textContent = ml + ' · '; s.lang = 'ml'; el.append(s); }
  el.append(document.createTextNode(text));
  $('toasts').append(el);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  setTimeout(() => el.remove(), 4200);
}

// ---------- input ----------
const KEYS = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Space: 'brake', ShiftLeft: 'run', ShiftRight: 'run' };
function respawn() {
  Object.assign(me, spawnPoint(), { speed: 0, foot: false });
  me.avatar.visible = false;
  if (me.taken >= 0 || me.carType !== sel.car) { // back to your own car; the borrowed vehicle returns to traffic
    setMyCar(); syncTaken();
    socket?.emit('swap', { car: sel.car, color: sel.color, taken: -1 });
  }
}

// The traffic vehicle close enough to take, if any. Traffic does not stop, so the reach is generous.
function nearVehicle() {
  let best = null, bd = 1e9;
  for (const v of traffic.vehicles) {
    const d = Math.hypot(v.x - me.x, v.z - me.z) - v.r;
    if (d < (me.foot ? 14 : 9) && d < bd) { bd = d; best = v; }
  }
  return best;
}
function takeVehicle(v) {
  if (!socket) return;
  const speed = ALL_CARS.find((c) => c.id === v.type).maxSpeed * 0.35;
  const at = { x: v.x, z: v.z, rot: v.rot };
  socket.emit('swap', { car: v.type, color: v.paint, taken: v.id }, (ok) => {
    if (!ok) return toast(null, 'Someone else is already driving that one.');
    me.taken = v.id;
    setDriveModel(v.type, v.paint);
    Object.assign(me, at, { foot: false, speed });
    me.avatar.visible = false;
    syncTaken();
    toast(me.spec.name, 'You are driving it now. Press R to go back to your own car.');
  });
}

// Get out of the car and walk, or get back in when you are next to it.
// F also takes over a traffic vehicle within reach; the Walk / Drive button never does.
function toggleFoot(takeTraffic = true) {
  if (mode !== 'play') return;
  const v = takeTraffic && nearVehicle();
  if (v && (me.foot ? Math.hypot(me.car.x - me.x, me.car.z - me.z) >= 4.5 : true)) return takeVehicle(v);
  if (!me.foot) {
    if (Math.abs(me.speed) > 3) return toast(null, 'Stop the car before getting out.');
    me.car = { x: me.x, z: me.z, rot: me.rot };
    me.foot = true; me.speed = 0;
    me.x -= Math.cos(me.rot) * 2.2; me.z += Math.sin(me.rot) * 2.2; // step out on the driver's side
    me.avatar.visible = true;
    toast(null, 'On foot. Hold Shift to run, F at your car to drive again.');
  } else if (Math.hypot(me.car.x - me.x, me.car.z - me.z) < 4.5) {
    Object.assign(me, me.car, { foot: false, speed: 0 });
    me.avatar.visible = false;
  } else toast(null, 'Walk back to your car to drive, or press R to respawn in it.');
}
addEventListener('keydown', (e) => {
  if (mode !== 'play' || e.target.tagName === 'INPUT') return;
  if (KEYS[e.code]) { input[KEYS[e.code]] = true; e.preventDefault(); }
  if (e.code === 'KeyH' && !e.repeat) honk();
  if (e.code === 'KeyR' && !e.repeat) respawn();
  if (e.code === 'KeyF' && !e.repeat) toggleFoot();
  if (e.code === 'KeyE' && !e.repeat && nearShop) openDialog(nearShop);
  if (e.code === 'Escape') { closeDialog(); showTrips(false); }
  if (e.code === 'Enter') { e.preventDefault(); $('chatInput').focus(); }
});
addEventListener('keyup', (e) => { if (KEYS[e.code]) input[KEYS[e.code]] = false; });
addEventListener('blur', () => Object.keys(input).forEach((k) => (input[k] = false)));
document.querySelectorAll('#touch button').forEach((b) => {
  const k = b.dataset.k;
  const set = (v) => (e) => { e.preventDefault(); if (k === 'honk') { if (v) honk(); } else if (k === 'exit') { if (v) toggleFoot(); } else { input[k] = v; if (k === 'up') input.run = v; } };
  b.addEventListener('pointerdown', set(true));
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, set(false));
});

// ---------- driving ----------
// On a road (including bridges) the car sits on the road surface; elsewhere on the ground,
// or wading in shallow water.
const onRoad = (x, z) => distToRoad(x, z) < 0.4;
const groundY = (x, z) => (onRoad(x, z) ? Math.max(heightAt(x, z), 0.15) + 0.12 : heightAt(x, z) + 0.1);
// How far below the water surface the ground is (0 on land and on bridges).
const depthAt = (x, z) => (onRoad(x, z) ? 0 : Math.max(0, WORLD.water - heightAt(x, z)));
// Cars wade up to the wheel arches, people up to the waist; deeper water needs a bridge.
const WADE_CAR = 0.95, WADE_FOOT = 1.15;
const blocked = (x, z, limit = WADE_CAR) => depthAt(x, z) > limit;
let lastDeepToast = 0;

function drive(dt) {
  const s = me.spec;
  const thr = (input.up ? 1 : 0) - (input.down ? 1 : 0);
  const steer = (input.left ? 1 : 0) - (input.right ? 1 : 0);
  const offroad = distToRoadOnly(me.x, me.z) > 0.6 && !inBeach(me.x, me.z); // the drive-in beach is hard sand; ballast is not
  const wet = Math.min(1, depthAt(me.x, me.z) / WADE_CAR);                // 0 dry .. 1 as deep as a car can go
  const max = s.maxSpeed * (offroad ? s.offroad : 1) * (1 - 0.7 * wet) * (performance.now() < me.boostUntil ? 1.15 : 1); // chai boost

  if (thr > 0) me.speed += s.accel * dt;
  else if (thr < 0) me.speed -= (me.speed > 0 ? 24 : s.accel * 0.6) * dt;
  else me.speed -= Math.sign(me.speed) * Math.min(Math.abs(me.speed), 5 * dt);
  if (input.brake) me.speed -= Math.sign(me.speed) * Math.min(Math.abs(me.speed), 32 * dt);
  if (me.speed > max) me.speed -= Math.min(me.speed - max, 16 * dt);
  if (me.speed < -7) me.speed = -7;
  me.rot += steer * s.turn * Math.max(-1, Math.min(1, me.speed / 6)) * dt;

  let x = me.x + Math.sin(me.rot) * me.speed * dt;
  let z = me.z + Math.cos(me.rot) * me.speed * dt;

  // sea and rivers: splash in the shallows, cross deep water only on bridges (slide along the bank)
  if (blocked(x, z)) {
    if (Math.abs(me.speed) > 4) { // ploughing into deep water: a big splash, and the water stops you
      waterFx.spray(x, z, Math.sin(me.rot), Math.cos(me.rot), Math.min(70, Math.abs(me.speed) * 5), 4 + Math.abs(me.speed) * 0.15);
      waterFx.ripple(x, z, 7, 2.2);
      if (performance.now() - lastDeepToast > 5000) { lastDeepToast = performance.now(); toast(null, 'Too deep to drive any further. Rivers can only be crossed on a bridge.'); }
    }
    if (!blocked(x, me.z)) z = me.z;
    else if (!blocked(me.x, z)) x = me.x;
    else { x = me.x; z = me.z; }
    me.speed *= 0.6;
  }
  x = Math.max(BOUNDS.x0 + 4, Math.min(BOUNDS.x1 - 4, x));
  z = Math.max(BOUNDS.z0 + 4, Math.min(BOUNDS.z1 - 4, z));

  for (const c of nearColliders(x, z)) {
    const dx = x - c.x, dz = z - c.z, min = c.r + 1.3;
    if (Math.abs(dx) > min || Math.abs(dz) > min) continue;
    const d = Math.hypot(dx, dz);
    if (d < min && d > 0.001) { x = c.x + (dx / d) * min; z = c.z + (dz / d) * min; me.speed *= 0.6; }
  }
  for (const v of [...traffic.vehicles, ...world.trains]) {
    const dx = x - v.x, dz = z - v.z, min = v.r + 1.2, d = Math.hypot(dx, dz);
    if (d < min && d > 0.001) { x = v.x + (dx / d) * min; z = v.z + (dz / d) * min; me.speed *= 0.5; }
  }
  remotes.forEach((r) => {
    const dx = x - r.x, dz = z - r.z, d = Math.hypot(dx, dz);
    if (d < 2.6 && d > 0.001) { x += (dx / d) * (2.6 - d) * 0.5; z += (dz / d) * (2.6 - d) * 0.5; me.speed *= 0.85; }
  });
  me.x = x; me.z = z;
}

const WALK = 2.2, RUN = 5.5;
function walk(dt) {
  const thr = (input.up ? 1 : 0) - (input.down ? 1 : 0);
  const steer = (input.left ? 1 : 0) - (input.right ? 1 : 0);
  me.speed = thr > 0 ? (input.run ? RUN : WALK) : thr < 0 ? -WALK * 0.6 : 0;
  if (depthAt(me.x, me.z) > 0.3) me.speed *= 0.5;                  // wading is slow
  me.rot += steer * 2.6 * dt;
  let x = me.x + Math.sin(me.rot) * me.speed * dt;
  let z = me.z + Math.cos(me.rot) * me.speed * dt;
  if (blocked(x, z, WADE_FOOT)) { x = me.x; z = me.z; }
  x = Math.max(BOUNDS.x0 + 4, Math.min(BOUNDS.x1 - 4, x));
  z = Math.max(BOUNDS.z0 + 4, Math.min(BOUNDS.z1 - 4, z));
  for (const c of nearColliders(x, z)) {
    const dx = x - c.x, dz = z - c.z, min = c.r + 0.45, d = Math.hypot(dx, dz);
    if (d < min && d > 0.001) { x = c.x + (dx / d) * min; z = c.z + (dz / d) * min; }
  }
  for (const v of [...traffic.vehicles, ...world.trains]) {
    const dx = x - v.x, dz = z - v.z, min = v.r + 0.4, d = Math.hypot(dx, dz);
    if (d < min && d > 0.001) { x = v.x + (dx / d) * min; z = v.z + (dz / d) * min; }
  }
  me.x = x; me.z = z;
}

// Spray and ripples for anything moving through water: wheels throw spray back and out,
// and a wake of rings follows. `who` keeps a little timer per car or person.
function wake(who, x, z, rot, speed, dt, foot) {
  const d = depthAt(x, z), v = Math.abs(speed);
  if (d < 0.03) return;
  who.wakeT = (who.wakeT || 0) - dt;
  if (who.wakeT <= 0 && (v > 0.4 || Math.random() < dt * 0.6)) {
    who.wakeT = foot ? 0.45 : Math.max(0.12, 0.5 - v * 0.02);
    waterFx.ripple(x, z, foot ? 1.4 : 2.5 + v * 0.12, foot ? 1.2 : 1.8);
  }
  if (foot || v < 1.5) return;
  const fx = Math.sin(rot), fz = Math.cos(rot), back = Math.sign(speed);
  const n = Math.min(6, Math.ceil(v * dt * 3 * (0.4 + Math.min(1, d * 2))));
  for (const side of [1, -1]) {               // from each wheel line, thrown backwards and outwards
    const wx = x + fz * side * 0.85, wz = z - fx * side * 0.85;
    waterFx.spray(wx - fx * back * 1.2, wz - fz * back * 1.2, -fx * back + fz * side * 0.6, -fz * back - fx * side * 0.6, n, 1.2 + v * 0.12);
    waterFx.spray(wx + fx * back * 1.3, wz + fz * back * 1.3, fz * side, -fx * side, Math.ceil(n / 2), 1 + v * 0.08);
  }
}

function placeAvatar(av, x, z, rot, speed, t) {
  const moving = Math.abs(speed) > 0.2;
  av.position.set(x, groundY(x, z) - 0.1 + (moving ? Math.abs(Math.sin(t * (Math.abs(speed) > 3 ? 14 : 9))) * 0.09 : 0), z);
  av.rotation.y = rot;
  av.userData.arm.rotation.x = moving ? Math.sin(t * (Math.abs(speed) > 3 ? 14 : 9)) * 0.8 : 0;
}

function place(group, x, z, rot, speed, dt) {
  const fx = Math.sin(rot), fz = Math.cos(rot);
  const y = groundY(x, z);
  group.position.set(x, y, z);
  group.rotation.y = rot;
  group.rotation.x = -Math.atan2(groundY(x + fx * 1.5, z + fz * 1.5) - groundY(x - fx * 1.5, z - fz * 1.5), 3);
  for (const w of group.userData.wheels) w.rotation.x += speed * dt * 2.5;
}

// ---------- minimap ----------
// A north-up map centred on the car. Press M to switch between the local view and all of Kannur.
const map = $('map'), mctx = map.getContext('2d');
const MS = map.width;
const MK = 0.5; // base map pixels per world unit
const mapBase = document.createElement('canvas');
mapBase.width = Math.round((BOUNDS.x1 - BOUNDS.x0) * MK);
mapBase.height = Math.round((BOUNDS.z1 - BOUNDS.z0) * MK);
{
  const c = mapBase.getContext('2d');
  const cv = document.createElement('canvas');
  cv.width = TERRAIN.w; cv.height = TERRAIN.h;
  const tc = cv.getContext('2d');
  const img = new ImageData(new Uint8ClampedArray(terrainPx), TERRAIN.w, TERRAIN.h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const water = d[i] < 127.5, s = d[i + 1];
    const col = water ? [47, 147, 184] : s === SURF.drivein ? [232, 196, 120] : s === SURF.sand ? [236, 220, 171] : s === SURF.paddy ? [165, 220, 102] : [125, 187, 92];
    d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255;
  }
  tc.putImageData(img, 0, 0);
  c.imageSmoothingEnabled = true;
  c.drawImage(cv, 0, 0, mapBase.width, mapBase.height);
  const bx = (x) => (x - BOUNDS.x0) * MK, bz = (z) => (z - BOUNDS.z0) * MK;
  c.lineCap = c.lineJoin = 'round';
  for (const [cls, col, w] of [['q', '#5b5d63', 2], ['s', '#3b3c42', 3], ['p', '#3b3c42', 4], ['t', '#e8a33d', 5]]) {
    c.strokeStyle = col; c.lineWidth = w;
    ROADS.filter((r) => r.cls === cls).forEach((r) => {
      c.beginPath();
      r.pts.forEach(([x, z], i) => (i ? c.lineTo(bx(x), bz(z)) : c.moveTo(bx(x), bz(z))));
      c.stroke();
    });
  }
  // the railway: a dark line with white ticks, as on printed maps
  const rl = RAILWAY.line;
  for (const [col, w, dash] of [['#2b2b2b', 4, []], ['#ffffff', 2, [6, 6]]]) {
    c.strokeStyle = col; c.lineWidth = w; c.setLineDash(dash);
    c.beginPath();
    for (let i = 0; i < rl.length; i += 2) (i ? c.lineTo(bx(rl[i]), bz(rl[i + 1])) : c.moveTo(bx(rl[i]), bz(rl[i + 1])));
    c.stroke();
  }
  c.setLineDash([]);
}
let mapRadius = 220; // world units from the centre to the edge of the minimap
addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && !e.repeat && mode === 'play') mapRadius = mapRadius < 1000 ? 1300 : 220;
});
map.addEventListener('click', () => { mapRadius = mapRadius < 1000 ? 1300 : 220; });

function drawMap() {
  const whole = mapRadius > 1000;
  const cx = whole ? (BOUNDS.x0 + BOUNDS.x1) / 2 : me.x, cz = whole ? (BOUNDS.z0 + BOUNDS.z1) / 2 : me.z;
  const k = MS / (2 * mapRadius);
  const mx = (x) => (x - cx) * k + MS / 2, mz = (z) => (z - cz) * k + MS / 2;
  mctx.fillStyle = '#2f93b8';
  mctx.fillRect(0, 0, MS, MS);
  mctx.drawImage(mapBase, (cx - mapRadius - BOUNDS.x0) * MK, (cz - mapRadius - BOUNDS.z0) * MK, 2 * mapRadius * MK, 2 * mapRadius * MK, 0, 0, MS, MS);
  const clampEdge = (v) => Math.max(8, Math.min(MS - 8, v));
  for (const lm of LANDMARKS) {
    const found = stats.discovered.has(lm.id);
    let x = mx(lm.x), z = mz(lm.z);
    const off = x < 0 || z < 0 || x > MS || z > MS;
    if (off && found) continue;
    x = clampEdge(x); z = clampEdge(z);   // undiscovered places off the map show on its edge
    mctx.fillStyle = found ? '#0f3d2e' : '#ffd54f';
    mctx.strokeStyle = '#fff'; mctx.lineWidth = 2;
    mctx.beginPath();
    if (off) { mctx.arc(x, z, 5, 0, 7); } else mctx.rect(x - 6, z - 6, 12, 12);
    mctx.fill(); mctx.stroke();
  }
  if (!whole) {
    mctx.fillStyle = '#7cb342';
    coconuts.forEach((m) => { mctx.beginPath(); mctx.arc(mx(m.position.x), mz(m.position.z), 2.5, 0, 7); mctx.fill(); });
  }
  remotes.forEach((r) => {
    mctx.fillStyle = r.color; mctx.strokeStyle = '#fff'; mctx.lineWidth = 2;
    mctx.beginPath(); mctx.arc(mx(r.x), mz(r.z), 6, 0, 7); mctx.fill(); mctx.stroke();
  });
  // you: an arrow pointing where the car is heading
  mctx.save();
  mctx.translate(mx(me.x), mz(me.z));
  mctx.rotate(Math.PI - me.rot);
  mctx.fillStyle = '#fff'; mctx.strokeStyle = '#0f3d2e'; mctx.lineWidth = 3;
  mctx.beginPath(); mctx.moveTo(0, -12); mctx.lineTo(8, 9); mctx.lineTo(0, 4); mctx.lineTo(-8, 9); mctx.closePath();
  mctx.stroke(); mctx.fill();
  mctx.restore();
  mctx.fillStyle = 'rgba(0,0,0,.55)'; mctx.font = '11px system-ui, sans-serif';
  mctx.fillText('© OpenStreetMap', 6, MS - 6);
}

// ---------- shopkeepers ----------
let nearShop = null, dlgShop = null;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
function directions() {
  const todo = LANDMARKS.filter((l) => !stats.discovered.has(l.id));
  if (!todo.length) return 'You have seen every place I know. Nothing left to show you!';
  const lm = todo.reduce((a, b) => (Math.hypot(a.x - me.x, a.z - me.z) < Math.hypot(b.x - me.x, b.z - me.z) ? a : b));
  const dx = lm.x - me.x, dz = lm.z - me.z;
  const dir = COMPASS[Math.round(((Math.atan2(dx, -dz) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8];
  return `Go to ${lm.name}. It is about ${(Math.hypot(dx, dz) / 100).toFixed(1)} km to the ${dir}. Watch for the yellow light.`;
}
function whoIsAround() {
  if (!remotes.size) return 'Only you on the road right now. Bring your friends and I will have more customers.';
  const list = [...remotes.values()].map((r) => `${r.name} (${(Math.hypot(r.x - me.x, r.z - me.z) / 100).toFixed(1)} km away${r.foot ? ', walking' : ''})`);
  return 'I have seen ' + list.join(', ') + '. Press Enter to chat with them.';
}
function openDialog(shop) {
  dlgShop = shop;
  $('talkPrompt').hidden = true;
  $('dlgTitle').textContent = `${shop.keeper} · ${shop.type.name}`;
  $('dlgSub').textContent = shop.type.ml;
  $('dlgText').textContent = `Namaskaram! ${pick(shop.type.lines)}`;
  const opts = [
    ["What's good here?", () => pick(shop.type.lines)],
    ['Where should I go next?', directions],
    ['Who else is around?', whoIsAround],
  ];
  if (shop.type.action === 'chai') opts.push(['Have a chaya (speed boost for a minute)', () => { me.boostUntil = performance.now() + 60_000; beep(740, 0.15, 'triangle'); return 'There you go, piping hot. You will drive faster for the next minute.'; }]);
  $('dlgOpts').innerHTML = '';
  for (const [label, fn] of opts) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { $('dlgText').textContent = fn(); };
    $('dlgOpts').append(b);
  }
  $('dialog').hidden = false;
}
function closeDialog() { dlgShop = null; $('dialog').hidden = true; }
$('dlgClose').onclick = closeDialog;
$('talkPrompt').onclick = () => nearShop && openDialog(nearShop);
$('carPrompt').onclick = toggleFoot;

// ---------- walk / drive button ----------
function updateFootBtn() {
  const label = me.foot ? '🚗 Drive' : '🚶 Walk';
  if ($('footBtn').textContent !== label) $('footBtn').textContent = label;
}
$('footBtn').onclick = (e) => {
  e.currentTarget.blur(); // keep Space and Enter for driving and chat
  if (mode !== 'play') return;
  if (!me.foot || Math.hypot(me.car.x - me.x, me.car.z - me.z) < 4.5) toggleFoot(false);
  else if (depthAt(me.x, me.z) > WADE_CAR) toast(null, 'Too deep for the car here. Walk back towards the shore.');
  else { // far from the car: it comes to you
    Object.assign(me, { foot: false, speed: 0 });
    me.avatar.visible = false;
    toast(null, 'Your car is here. Drive on.');
  }
  updateFootBtn();
};

// ---------- beach trips ----------
// Drop the player on a road just outside the beach, facing it, so they drive the last stretch
// (and still discover the place by getting there).
const BEACHES = [
  { id: 'beach', note: 'Drive along 4 km of hard sand' },
  { id: 'payyambalam', note: 'Town beach, next to Kannur' },
].map((b) => ({ ...b, lm: LANDMARKS.find((l) => l.id === b.id) })).filter((b) => b.lm);
function tripStart(lm) {
  let best = null, bd = Infinity;
  for (const r of ROADS) {
    if (r.bridge) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [x, z] = r.pts[i], d = Math.hypot(x - lm.x, z - lm.z);
      if (d < lm.r + 12 || d > lm.r + 90 || heightAt(x, z) < WORLD.water + 0.1) continue;
      // face along the road, in whichever direction heads towards the beach
      let tx = r.pts[i + 1][0] - x, tz = r.pts[i + 1][1] - z;
      const tl = Math.hypot(tx, tz) || 1, toward = (tx * (lm.x - x) + tz * (lm.z - z)) / (tl * d);
      if (Math.abs(toward) < 0.55) continue; // this stretch runs past the beach, not towards it
      if (toward < 0) { tx = -tx; tz = -tz; }
      const score = d * (2 - Math.abs(toward));
      if (score >= bd || !clearBehind(x, z, tx / tl, tz / tl)) continue;
      bd = score; best = { x, z, rot: Math.atan2(tx, tz) };
    }
  }
  return best ?? { x: lm.x + lm.r + 20, z: lm.z, rot: -Math.PI / 2 };
}
// Nothing solid on the car's spot or between it and the chase camera behind it.
function clearBehind(x, z, fx, fz) {
  for (let k = 0; k <= 13; k += 1.5) {
    const px = x - fx * k, pz = z - fz * k;
    for (const c of nearColliders(px, pz)) if (Math.hypot(c.x - px, c.z - pz) < c.r + 1.6) return false;
  }
  return true;
}
function showTrips(open) {
  $('trips').hidden = !open;
  $('beachBtn').setAttribute('aria-expanded', String(open));
}
for (const b of BEACHES) {
  const el = document.createElement('button'), s = document.createElement('small');
  el.textContent = b.lm.name;
  s.textContent = b.note;
  el.append(s);
  el.onclick = () => {
    showTrips(false);
    if (mode !== 'play') return;
    if (me.foot) { me.foot = false; me.avatar.visible = false; }
    Object.assign(me, tripStart(b.lm), { speed: 0 });
    first = true; // snap the camera instead of sweeping across the map
    updateFootBtn();
    toast(b.lm.name, 'Drive on to the sand.', b.lm.ml);
  };
  $('tripList').append(el);
}
$('beachBtn').onclick = (e) => { e.currentTarget.blur(); showTrips($('trips').hidden); };
function updateTalk() {
  nearShop = null;
  if (Math.abs(me.speed) < 6) {
    let best = 9;
    for (const sh of world.shops) {
      const d = Math.hypot(sh.x - me.x, sh.z - me.z);
      if (d < best) { best = d; nearShop = sh; }
    }
  }
  if (dlgShop && Math.hypot(dlgShop.x - me.x, dlgShop.z - me.z) > 14) closeDialog();
  updateFootBtn();
  const v = nearVehicle(), ownCar = me.foot && Math.hypot(me.car.x - me.x, me.car.z - me.z) < 4.5;
  $('carPrompt').hidden = !(v || ownCar);
  if (ownCar) $('carPrompt').textContent = 'F · Get back in';
  else if (v) $('carPrompt').textContent = `F · Drive this ${ALL_CARS.find((c) => c.id === v.type).name.toLowerCase()}`;
  const show = nearShop && !dlgShop;
  $('talkPrompt').hidden = !show;
  if (show) $('talkPrompt').textContent = `E · Talk to ${nearShop.keeper} (${nearShop.type.name})`;
}

// ---------- chat ----------
function say(id, name, text) {
  const li = document.createElement('li'), b = document.createElement('b');
  b.textContent = (id === myId ? 'You' : name) + ': ';
  li.append(b, document.createTextNode(text));
  $('chatLog').append(li);
  while ($('chatLog').children.length > 6) $('chatLog').firstChild.remove();
  setTimeout(() => li.remove(), 30_000);
  // speech bubble over the speaker
  const r = id === myId ? me : remotes.get(id);
  if (!r) return;
  const body = r.foot ? r.avatar : r.group;
  if (r.bubble) r.bubble.removeFromParent();
  const bubble = makeLabel(text.length > 42 ? text.slice(0, 40) + '…' : text, { bg: '#fffdf4', fg: '#1c1c1c', height: 0.9 });
  bubble.position.y = r.foot ? 3.5 : 4.3;
  body.add(bubble);
  r.bubble = bubble;
  setTimeout(() => { if (r.bubble === bubble) { bubble.removeFromParent(); r.bubble = null; } }, 6000);
  if (id !== myId) beep(600, 0.06, 'sine');
}
$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (text) socket?.emit('chat', text);
  $('chatInput').value = '';
  $('chatInput').blur();
};
$('chatInput').addEventListener('keydown', (e) => { if (e.code === 'Escape') $('chatInput').blur(); });
$('chatInput').addEventListener('focus', () => Object.keys(input).forEach((k) => (input[k] = false)));

// ---------- main loop ----------
const clock = new THREE.Clock();
const camTarget = new THREE.Vector3(), look = new THREE.Vector3();
let sendAcc = 0, slowAcc = 0, first = true;

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  world.update(t, camera);
  engineUpdate(dt);
  traffic.update(Date.now() / 1000);
  waterFx.update(dt);

  if (mode === 'play') {
    if (me.foot) { walk(dt); placeAvatar(me.avatar, me.x, me.z, me.rot, me.speed, t); }
    else { drive(dt); place(me.group, me.x, me.z, me.rot, me.speed, dt); }
    wake(me, me.x, me.z, me.rot, me.speed, dt, me.foot);
    updateFootBtn();

    const k = 1 - Math.exp(-10 * dt);
    remotes.forEach((r) => {
      r.x += (r.tx - r.x) * k; r.z += (r.tz - r.z) * k;
      let d = r.trot - r.rot;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      r.rot += d * k;
      if (r.foot) placeAvatar(r.avatar, r.x, r.z, r.rot, r.speed, t);
      else place(r.group, r.x, r.z, r.rot, r.speed, dt);
      wake(r, r.x, r.z, r.rot, r.speed, dt, r.foot);
    });

    coconuts.forEach((m, id) => {
      m.rotation.y = t * 1.5 + id;
      m.position.y = 1.4 + Math.sin(t * 2.4 + id) * 0.2;
      if (!pending.has(id) && Math.hypot(m.position.x - me.x, m.position.z - me.z) < 3.4) { pending.add(id); socket?.emit('collect', id); }
    });

    sendAcc += dt;
    if (sendAcc > 0.066 && socket?.connected) {
      sendAcc = 0;
      socket.volatile.emit('move', [+me.x.toFixed(2), +me.z.toFixed(2), +me.rot.toFixed(3), +me.speed.toFixed(1), me.foot ? 1 : 0]);
    }
    slowAcc += dt;
    stats.distance += Math.abs(me.speed) * dt;
    if (slowAcc > 0.2) {
      slowAcc = 0;
      for (const lm of LANDMARKS)
        if (!stats.discovered.has(lm.id) && Math.hypot(lm.x - me.x, lm.z - me.z) < lm.r) socket?.emit('discover', lm.id);
      $('kmh').textContent = Math.round(Math.abs(me.speed) * 3.6);
      $('sDist').textContent = (stats.distance / 1000).toFixed(1);
      drawMap();
      updateTalk();
    }

    const body = me.foot ? me.avatar : me.group;
    const dist = me.foot ? 5.2 : 6.5 + me.group.userData.len;
    const fx = Math.sin(me.rot), fz = Math.cos(me.rot);
    camTarget.set(me.x - fx * dist, body.position.y + (me.foot ? 3.2 : 4.6), me.z - fz * dist);
    if (first) { camera.position.copy(camTarget); first = false; }
    camera.position.lerp(camTarget, 1 - Math.exp(-4.5 * dt));
    camera.position.y = Math.max(camera.position.y, heightAt(camera.position.x, camera.position.z) + 1.6);
    look.set(me.x + fx * 5, body.position.y + 1.6, me.z + fz * 5);
    camera.lookAt(look);
  } else {
    // menu: slow orbit around the chosen car
    first = true;
    place(me.group, me.x, me.z, me.rot, 0, dt);
    const a = t * 0.25 + 2.2;
    const cx = me.x + Math.sin(a) * 10, cz = me.z + Math.cos(a) * 10, gy = me.group.position.y;
    camera.position.set(cx, Math.max(gy + 4.2, heightAt(cx, cz) + 1.6), cz); // above the ground, on hills too
    camera.lookAt(me.x, gy + 1, me.z);
  }
  const co = window.__kd?.camOverride; // debugging aid: { pos: [x, y, z], look: [x, y, z] }
  if (co) { camera.position.set(...co.pos); camera.lookAt(...co.look); }
  view.follow(me.x, groundAt(me.x, me.z), me.z);
  view.render();
  requestAnimationFrame(frame);
}

showMenu();
frame();
window.__kd = { me, remotes, coconuts, stats, world, traffic, renderer }; // handy for debugging in the console
