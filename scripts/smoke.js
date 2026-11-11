// End-to-end check against a running server: `npm start` in one terminal, `npm run smoke` in another.
import { io } from 'socket.io-client';
import assert from 'node:assert/strict';

const URL = process.env.URL || 'http://localhost:3000';
const post = (p, body, token) =>
  fetch(URL + '/api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));
const join = (sock, data) => new Promise((res) => sock.emit('join', data, res));
const once = (sock, ev) => new Promise((res) => sock.once(ev, res));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const name = 'smoke_' + Math.floor(Math.random() * 1e6);
const reg = await post('/register', { username: name, password: 'secret123' });
assert.equal(reg.status, 200, 'register');
assert.equal((await post('/register', { username: name, password: 'secret123' })).status, 409, 'duplicate username rejected');
assert.equal((await post('/login', { username: name, password: 'wrong-pass' })).status, 401, 'wrong password rejected');
const login = await post('/login', { username: name, password: 'secret123' });
assert.ok(login.token, 'login returns a token');

const a = io(URL, { auth: { token: login.token } });
const b = io(URL);
const ja = await join(a, { car: 'sedan', color: '#c62828' });
const joined = once(a, 'playerJoined');
const jb = await join(b, { name: 'Guest <b>B</b>', car: 'nope', color: 'red' });
assert.equal(ja.room, jb.room, 'both players land in the same public room');
assert.equal(jb.players.length, 1, 'B sees A');
assert.equal(jb.players[0].name, name, 'logged-in player uses their username');
const pj = await joined;
assert.equal(pj.name, 'Guest bBb', 'guest name is sanitised');
assert.equal(pj.car, 'sedan', 'invalid car falls back to default');
assert.equal(ja.coconuts.length, 160, 'room has coconuts');

// chat reaches everyone in the room, trimmed and capped
const heard = once(b, 'chat');
a.emit('chat', '  hello from A  ' + 'x'.repeat(300));
const msg = await heard;
assert.equal(msg.name, name, 'chat carries the sender name');
assert.ok(msg.text.startsWith('hello from A') && msg.text.length === 120, 'chat text is trimmed and capped');

// taking a vehicle from traffic: everyone is told, and nobody else can take the same one
const swapped = once(b, 'playerCar');
assert.equal(await new Promise((res) => a.emit('swap', { car: 'bus', color: '#c0392b', taken: 3 }, res)), true, 'A takes a bus');
assert.deepEqual(await swapped, { id: ja.id, car: 'bus', color: '#c0392b', taken: 3 }, 'B is told about the bus');
assert.equal(await new Promise((res) => b.emit('swap', { car: 'bus', color: '#c0392b', taken: 3 }, res)), false, 'B cannot take the same bus');
assert.equal(await new Promise((res) => b.emit('swap', { car: 'rocket', color: '#c0392b', taken: 4 }, res)), false, 'unknown vehicle rejected');

// A drives to a coconut and collects it
const c = ja.coconuts[0];
const gone = once(b, 'coconutGone');
a.emit('collect', c.id); // too far away: must be ignored
await wait(150);
a.emit('move', [c.x, c.z, 0, 5, 1]); // on foot
const state = await once(b, 'state');
assert.ok(state.some((s) => s[0] === ja.id && s[1] === Math.round(c.x * 100) / 100 && s[5] === 1), 'B receives A position and on-foot flag');
const st = once(a, 'stats');
a.emit('collect', c.id);
assert.equal((await gone).id, c.id, 'coconut removed for everyone');
assert.equal((await st).coconuts, 1, 'collector gets credit once');

// discovery only counts when you are actually there
const disc = once(a, 'discovered');
a.emit('discover', 'temple'); // not there yet
await wait(100);
const { LANDMARKS } = await import('../shared/world.js');
const temple = LANDMARKS.find((l) => l.id === 'temple');
a.emit('move', [temple.x, temple.z, 0, 0]);
await wait(100);
a.emit('discover', 'temple');
assert.deepEqual((await disc).discovered, ['temple'], 'landmark discovered');

const left = once(b, 'playerLeft');
a.disconnect();
assert.equal(await left, ja.id, 'B is told when A leaves');
b.disconnect();

await wait(1300);
const board = await fetch(URL + '/api/leaderboard').then((r) => r.json());
assert.ok(board.coconuts.some((r) => r.username === name && r.value === 1), 'leaderboard shows saved score');
console.log('All smoke checks passed.');
process.exit(0);
