import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store } from './store.js';
import { CARS, ALL_CARS, TRAFFIC_TOTAL, COLORS, LANDMARKS, COCONUT_SPOTS, WORLD, spawnPoint } from '../shared/world.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 3000;
const store = new Store(process.env.DATA_FILE || path.join(root, 'data', 'db.json'));

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use('/shared', express.static(path.join(root, 'shared')));
app.use('/vendor/three', express.static(path.join(root, 'node_modules', 'three')));
app.use(express.static(path.join(root, 'client')));

// ---------- accounts ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64);
const hashTok = (t) => crypto.createHash('sha256').update(t).digest('hex');
const users = () => Object.values(store.data.users);

function userFromToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const s = store.data.sessions[hashTok(token)];
  return (s && store.data.users[s.uid]) || null;
}
function issueToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  store.data.sessions[hashTok(token)] = { uid: user.id, at: Date.now() };
  store.save();
  return token;
}
const publicProfile = (u) => ({
  username: u.username,
  coconuts: u.coconuts,
  distance: Math.round(u.distance),
  discovered: u.discovered,
});

const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const h = hits.get(req.ip);
  if (!h || now > h.reset) hits.set(req.ip, { n: 1, reset: now + 60_000 });
  else if (++h.n > 20) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  next();
}

app.post('/api/register', rateLimit, (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(username))
    return res.status(400).json({ error: 'Username must be 3-16 letters, numbers or underscores.' });
  if (typeof password !== 'string' || password.length < 6 || password.length > 100)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (users().some((u) => u.username.toLowerCase() === username.toLowerCase()))
    return res.status(409).json({ error: 'That username is taken.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomUUID(), username, salt, pass: hashPw(password, salt).toString('hex'),
    coconuts: 0, distance: 0, discovered: [], createdAt: Date.now(),
  };
  store.data.users[user.id] = user;
  res.json({ token: issueToken(user), profile: publicProfile(user) });
});

app.post('/api/login', rateLimit, (req, res) => {
  const { username, password } = req.body || {};
  const user = typeof username === 'string' && users().find((u) => u.username.toLowerCase() === username.toLowerCase());
  const ok = user && typeof password === 'string' &&
    crypto.timingSafeEqual(hashPw(password, user.salt), Buffer.from(user.pass, 'hex'));
  if (!ok) return res.status(401).json({ error: 'Wrong username or password.' });
  res.json({ token: issueToken(user), profile: publicProfile(user) });
});

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');

app.get('/api/me', (req, res) => {
  const user = userFromToken(bearer(req));
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  res.json({ profile: publicProfile(user) });
});

app.post('/api/logout', (req, res) => {
  delete store.data.sessions[hashTok(bearer(req))];
  store.save();
  res.json({ ok: true });
});

app.get('/api/leaderboard', (_req, res) => {
  const top = (key) =>
    users().map(publicProfile)
      .map((p) => ({ username: p.username, value: key === 'discovered' ? p.discovered.length : p[key] }))
      .filter((p) => p.value > 0).sort((a, b) => b.value - a.value).slice(0, 10);
  res.json({ coconuts: top('coconuts'), distance: top('distance'), places: top('discovered'), totalPlaces: LANDMARKS.length });
});

// ---------- rooms ----------
const httpServer = createServer(app);
const io = new Server(httpServer);
const rooms = new Map();
let roomSeq = 1;
const COCONUTS_PER_ROOM = 160; // the real-map world is large
const r2 = (n) => Math.round(n * 100) / 100;

function spawnCoconut(room) {
  const used = new Set([...room.coconuts.values()].map((c) => c.spot));
  let spot;
  do spot = Math.floor(Math.random() * COCONUT_SPOTS.length); while (used.has(spot));
  const c = { id: room.nextCoconut++, spot, x: COCONUT_SPOTS[spot][0], z: COCONUT_SPOTS[spot][1] };
  room.coconuts.set(c.id, c);
  return c;
}

function findRoom() {
  for (const room of rooms.values()) if (room.players.size < WORLD.roomSize) return room;
  const room = { id: 'room-' + roomSeq++, players: new Map(), coconuts: new Map(), nextCoconut: 1, timers: new Set() };
  for (let i = 0; i < COCONUTS_PER_ROOM; i++) spawnCoconut(room);
  rooms.set(room.id, room);
  return room;
}

const cleanName = (name) =>
  String(name ?? '').replace(/[^\p{L}\p{M}\p{N} _-]/gu, '').trim().slice(0, 16) || 'Guest' + Math.floor(1000 + Math.random() * 9000);

const publicPlayer = (p) => ({ id: p.id, name: p.name, car: p.car, color: p.color, x: r2(p.x), z: r2(p.z), rot: r2(p.rot), foot: p.foot ? 1 : 0, taken: p.taken });

function leave(socket) {
  const room = rooms.get(socket.data.roomId);
  socket.data.roomId = null;
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(room.id);
  io.to(room.id).emit('playerLeft', socket.id);
  store.save();
  if (room.players.size === 0) {
    room.timers.forEach(clearTimeout);
    rooms.delete(room.id);
  }
}

io.on('connection', (socket) => {
  const user = userFromToken(socket.handshake.auth?.token);
  const me = () => rooms.get(socket.data.roomId)?.players.get(socket.id);

  socket.on('join', (data, ack) => {
    if (typeof ack !== 'function') return;
    leave(socket);
    const room = findRoom();
    const sp = spawnPoint();
    const p = {
      id: socket.id, user, ...sp, speed: 0, lastHonk: 0, lastChat: 0, foot: false, taken: -1,
      name: user ? user.username : cleanName(data?.name),
      car: CARS.some((c) => c.id === data?.car) ? data.car : CARS[0].id,
      color: COLORS.includes(data?.color) ? data.color : COLORS[0],
      // guests keep stats for the session only
      stats: user || { coconuts: 0, distance: 0, discovered: [] },
    };
    room.players.set(socket.id, p);
    socket.data.roomId = room.id;
    socket.join(room.id);
    socket.to(room.id).emit('playerJoined', publicPlayer(p));
    ack({
      id: socket.id, room: room.id, spawn: sp,
      players: [...room.players.values()].filter((o) => o.id !== socket.id).map(publicPlayer),
      coconuts: [...room.coconuts.values()].map(({ id, x, z }) => ({ id, x, z })),
      stats: { coconuts: p.stats.coconuts, distance: Math.round(p.stats.distance), discovered: p.stats.discovered },
    });
  });

  socket.on('move', (m) => {
    const p = me();
    if (!p || !Array.isArray(m) || m.length < 4 || !m.every(Number.isFinite)) return;
    const B = WORLD.bounds;
    const x = Math.max(B.x0, Math.min(B.x1, m[0]));
    const z = Math.max(B.z0, Math.min(B.z1, m[1]));
    const d = Math.hypot(x - p.x, z - p.z);
    if (d < 8) p.stats.distance += d; // ignore respawn jumps
    p.x = x; p.z = z; p.rot = m[2]; p.speed = m[3]; p.foot = m[4] === 1; // on foot or in the car
  });

  socket.on('collect', (id) => {
    const p = me();
    const room = rooms.get(socket.data.roomId);
    const c = room?.coconuts.get(id);
    if (!p || !c || Math.hypot(c.x - p.x, c.z - p.z) > 9) return;
    room.coconuts.delete(id);
    p.stats.coconuts++;
    if (p.user) store.save();
    io.to(room.id).emit('coconutGone', { id, by: p.id });
    socket.emit('stats', { coconuts: p.stats.coconuts });
    const t = setTimeout(() => {
      room.timers.delete(t);
      if (rooms.has(room.id)) io.to(room.id).emit('coconutSpawn', (({ id, x, z }) => ({ id, x, z }))(spawnCoconut(room)));
    }, 12_000);
    room.timers.add(t);
  });

  socket.on('discover', (id) => {
    const p = me();
    const lm = LANDMARKS.find((l) => l.id === id);
    if (!p || !lm || p.stats.discovered.includes(id)) return;
    if (Math.hypot(lm.x - p.x, lm.z - p.z) > lm.r + 10) return;
    p.stats.discovered.push(id);
    if (p.user) store.save();
    socket.emit('discovered', { id, discovered: p.stats.discovered });
    socket.to(socket.data.roomId).emit('notice', `${p.name} discovered ${lm.name}`);
  });

  socket.on('honk', () => {
    const p = me();
    if (!p || Date.now() - p.lastHonk < 600) return;
    p.lastHonk = Date.now();
    socket.to(socket.data.roomId).emit('honk', p.id);
  });

  // Switch to another vehicle: one taken from the road traffic (taken = its index), or back to your own car (-1).
  socket.on('swap', (data, ack) => {
    const p = me();
    const room = rooms.get(socket.data.roomId);
    const done = (ok) => typeof ack === 'function' && ack(ok);
    if (!p || !room || !data) return done(false);
    const taken = Number.isInteger(data.taken) && data.taken >= 0 && data.taken < TRAFFIC_TOTAL ? data.taken : -1;
    if (!ALL_CARS.some((c) => c.id === data.car) || !/^#[0-9a-f]{6}$/i.test(data.color)) return done(false);
    if (taken >= 0 && [...room.players.values()].some((o) => o !== p && o.taken === taken)) return done(false); // someone has it
    p.car = data.car; p.color = data.color.toLowerCase(); p.taken = taken;
    io.to(room.id).emit('playerCar', { id: p.id, car: p.car, color: p.color, taken });
    done(true);
  });

  // Room text chat. Plain text only, short, and rate limited.
  socket.on('chat', (text) => {
    const p = me();
    if (!p || typeof text !== 'string' || Date.now() - p.lastChat < 700) return;
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
    if (!clean) return;
    p.lastChat = Date.now();
    io.to(socket.data.roomId).emit('chat', { id: p.id, name: p.name, text: clean });
  });

  socket.on('leave', () => leave(socket));
  socket.on('disconnect', () => leave(socket));
});

// Broadcast positions 15 times a second.
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.players.size < 2) continue;
    io.to(room.id).volatile.emit('state', [...room.players.values()].map((p) => [p.id, r2(p.x), r2(p.z), r2(p.rot), r2(p.speed), p.foot ? 1 : 0]));
  }
}, 66);

// Persist distance driven by logged-in players.
setInterval(() => store.save(), 10_000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flush(); process.exit(0); });

httpServer.listen(PORT, () => console.log(`Kannur Drive running at http://localhost:${PORT}`));
