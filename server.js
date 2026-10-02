// Hexland Settlers online relay: serves the game and relays each room's moves in order.
// No dependencies. Run:  node server.js   (PORT env var, default 8080)
//
// The game itself runs in every player's browser (same seed, same rules). This server never
// looks at the rules: it hands out room codes, seats and colors, stamps every move with a
// sequence number, keeps the full move log so anyone can reconnect, and forwards messages.
// The log is the single source of truth: every browser applies moves in log order, a move is
// stored once even if a flaky connection sends it twice, and a browser that drifts from the
// others is told to rebuild its game from the log.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || '';        // optional: keep started rooms across restarts
const MAX_ROOMS = 400, MAX_LOG = 60000, ROOM_TTL = 1000 * 60 * 60 * 12;
const COLORS = 6;

const rooms = new Map();
const now = () => Date.now();
const rid = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let c; do { c = Array.from({length: 4}, () => A[crypto.randomInt(A.length)]).join(''); } while (rooms.has(c)); return c; };
const clean = (s, n = 18) => String(s ?? '').replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, n);

// ---------- persistence ----------
const evKey = (s, sid, mid) => `${s}:${sid || ''}:${mid}`; // one move = one key, however often it is sent
function save() {
  if (!DATA_FILE) return;
  const out = [...rooms.values()].filter(r => r.started).map(r => ({code: r.code, host: r.host, cfg: r.cfg, seats: r.seats, seed: r.seed, startCfg: r.startCfg, log: r.log, made: r.made, last: r.last}));
  try { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(out)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); } catch (e) { console.error('save failed', e.message); }
}
let saveT = null;
function touched(r) { // save shortly after a change, so a restart loses at most a second of play
  r.dirty = true;
  if (DATA_FILE && !saveT) saveT = setTimeout(() => { saveT = null; save(); }, 1000);
}
function load() {
  if (!DATA_FILE || !fs.existsSync(DATA_FILE)) return;
  try {
    for (const r of JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))) {
      const seen = new Set(r.log.filter(e => e.mid).map(e => evKey(e.s, e.sid, e.mid)));
      rooms.set(r.code, {...r, started: true, clients: new Map(), sums: new Map(), seen, chat: [], dirty: false});
    }
    console.log(`restored ${rooms.size} room(s)`);
  } catch (e) { console.error('load failed', e.message); }
}

// ---------- minimal WebSocket (RFC 6455) ----------
function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const hash = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${hash}\r\n\r\n`);
  socket.setNoDelay(true);
  const ws = {socket, alive: true, buf: Buffer.alloc(0), frag: [], open: true, cid: null, room: null, on: {}};
  socket.on('data', d => {
    ws.alive = true; // any traffic proves the connection still works
    ws.buf = Buffer.concat([ws.buf, d]);
    if (ws.buf.length > 1 << 20) return close(ws);
    for (;;) {
      const b = ws.buf;
      if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) return close(ws);
      if (b.length < off + (masked ? 4 : 0) + len) return;
      let payload = b.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len);
      if (masked) { const m = b.subarray(off, off + 4); payload = Buffer.from(payload.map((x, i) => x ^ m[i & 3])); }
      ws.buf = b.subarray(off + (masked ? 4 : 0) + len);
      if (op === 8) return close(ws);
      if (op === 9) { frame(ws, 10, payload); continue; }
      if (op === 10) { ws.alive = true; continue; }
      if (op === 0 || op === 1) {
        if (op === 1) ws.frag = [];
        ws.frag.push(payload);
        if (fin) { const msg = Buffer.concat(ws.frag).toString('utf8'); ws.frag = []; ws.on.message?.(msg); }
      }
    }
  });
  socket.on('close', () => { ws.open = false; ws.on.close?.(); });
  socket.on('error', () => socket.destroy());
  return ws;
}
function frame(ws, op, payload) {
  if (!ws.open) return;
  const len = payload.length, head = len < 126 ? Buffer.from([0x80 | op, len]) : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
  try { ws.socket.write(Buffer.concat([head, payload])); } catch { /* socket gone */ }
}
const send = (ws, obj) => frame(ws, 1, Buffer.from(JSON.stringify(obj)));
function close(ws) { if (ws.open) { frame(ws, 8, Buffer.alloc(0)); ws.open = false; ws.socket.end(); } ws.on.close?.(); }

// ---------- rooms ----------
const freeColor = r => { const used = new Set(r.seats.map(s => s.color)); for (let c = 0; c < COLORS; c++) if (!used.has(c)) return c; return 0; };
const seatOf = (r, cid) => r.seats.findIndex(s => s.kind === 'human' && s.cid === cid);
const online = (r, i) => !!(r.seats[i].cid && r.clients.get(r.seats[i].cid)?.open);
function lobbyState(r) {
  return {t: 'lobby', code: r.code, started: r.started, host: seatOf(r, r.host), cfg: r.cfg,
    seats: r.seats.map((s, i) => ({kind: s.kind, name: s.name, color: s.color, diff: s.diff, online: s.kind === 'human' && online(r, i)}))};
}
function broadcast(r, obj, except) { for (const w of r.clients.values()) if (w !== except && w.open) send(w, obj); }
function pushLobby(r) { broadcast(r, lobbyState(r)); }
function resize(r, n) {
  n = Math.max(3, Math.min(6, +n || 4));
  while (r.seats.length < n) r.seats.push({kind: 'open', color: freeColor(r), name: '', diff: 'normal'});
  if (r.seats.length > n) {
    const keep = r.seats.slice(0, n), lost = r.seats.slice(n).filter(s => s.kind === 'human');
    for (const s of lost) { const slot = keep.find(k => k.kind !== 'human'); if (slot) { Object.assign(slot, s); } }
    r.seats = keep;
    const seen = new Set(); r.seats.forEach(s => { if (seen.has(s.color)) s.color = -1; seen.add(s.color); });
    r.seats.forEach(s => { if (s.color < 0) s.color = freeColor(r); });
  }
}
function newRoom(cid, name, cfg) {
  const r = {code: rid(), host: cid, cfg: sanitizeCfg(cfg), seats: [], started: false, log: [], clients: new Map(), sums: new Map(), seen: new Set(), chat: [], made: now(), last: now(), seed: 0};
  r.seats.push({kind: 'human', cid, name, color: 0, diff: 'normal'});
  resize(r, r.cfg.n);
  rooms.set(r.code, r);
  return r;
}
function sanitizeCfg(c = {}) {
  const o = {n: Math.max(3, Math.min(6, +c.n || 4)), trade: Math.max(0, Math.min(4, +c.trade || 2)), sea: !!c.sea, ck: !!c.ck, scen: typeof c.scen === 'string' ? c.scen.slice(0, 20) : null, friendly: !!c.friendly, events: !!c.events, harbormaster: !!c.harbormaster};
  if (o.scen) { o.sea = o.ck = false; }
  return o;
}
function reassignHost(r) {
  const h = r.seats.findIndex(s => s.kind === 'human' && online(r, r.seats.indexOf(s)));
  if (h >= 0) r.host = r.seats[h].cid;
}

function handle(ws, raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'ping') return send(ws, {t: 'pong'});
  let r = ws.room && rooms.get(ws.room);

  if (m.t === 'create' || m.t === 'join') {
    const cid = clean(m.cid, 40), name = clean(m.name) || 'Player';
    if (!cid) return send(ws, {t: 'error', msg: 'Missing player id'});
    if (m.t === 'create') {
      if (rooms.size >= MAX_ROOMS) return send(ws, {t: 'error', msg: 'The server is full, try again later'});
      r = newRoom(cid, name, m.cfg);
    } else {
      r = rooms.get(clean(m.room, 8).toUpperCase());
      if (!r) return send(ws, {t: 'error', msg: 'No room with that code', fatal: true});
    }
    let seat = seatOf(r, cid);
    if (seat < 0) {
      if (r.started) return send(ws, {t: 'error', msg: 'That game has already started', fatal: true});
      seat = r.seats.findIndex(s => s.kind === 'open');
      if (seat < 0) return send(ws, {t: 'error', msg: 'That room is full', fatal: true});
      r.seats[seat] = {kind: 'human', cid, name, color: r.seats[seat].color, diff: 'normal'};
    }
    r.seats[seat].name = name;
    const old = r.clients.get(cid);
    if (old && old !== ws && old.open) { // the same player opened the game again (another tab or window): the newest one plays
      old.room = null; send(old, {t: 'error', code: 'replaced', fatal: true, msg: 'This game is open in another tab or window'}); close(old);
    }
    ws.cid = cid; ws.room = r.code; r.clients.set(cid, ws); r.last = now();
    if (!r.clients.get(r.host)?.open) r.host = cid;
    send(ws, {t: 'you', seat, code: r.code});
    if (r.started) {
      sendLog(ws, r, Number.isInteger(m.from) ? m.from : -1);
      broadcast(r, {t: 'presence', seat, online: true}, ws);
    } else send(ws, {t: 'chat', log: r.chat.slice(-50)});
    return pushLobby(r);
  }
  if (!r) return send(ws, {t: 'error', msg: 'Not in a room'});
  const seat = seatOf(r, ws.cid), isHost = r.host === ws.cid;
  r.last = now();

  switch (m.t) {
    case 'cfg': if (isHost && !r.started) { r.cfg = sanitizeCfg(m.cfg); resize(r, r.cfg.n); r.cfg.n = r.seats.length; pushLobby(r); } break;
    case 'name': { const n = clean(m.name); if (n && seat >= 0) { r.seats[seat].name = n; pushLobby(r); } break; }
    case 'color': {
      const c = Math.floor(+m.color);
      if (r.started || seat < 0 || !(c >= 0 && c < COLORS)) break;
      const other = r.seats.findIndex((s, i) => i !== seat && s.color === c);
      if (other >= 0) { if (r.seats[other].kind === 'human') return send(ws, {t: 'error', msg: 'That color is taken'}); r.seats[other].color = r.seats[seat].color; }
      r.seats[seat].color = c; pushLobby(r); break;
    }
    case 'seat': { // host: make a seat open / AI, or kick a player
      if (!isHost || r.started) break;
      const i = Math.floor(+m.i), s = r.seats[i];
      if (!s || (s.kind === 'human' && s.cid === r.host)) break;
      if (s.kind === 'human') { const w = r.clients.get(s.cid); if (w) { w.room = null; send(w, {t: 'error', msg: 'The host removed you from the room', fatal: true}); close(w); r.clients.delete(s.cid); } }
      const diff = ['easy', 'normal', 'hard'].includes(m.diff) ? m.diff : 'normal';
      r.seats[i] = {kind: m.kind === 'ai' ? 'ai' : 'open', name: '', color: s.color, diff};
      pushLobby(r); break;
    }
    case 'start': {
      if (!isHost || r.started) break;
      const used = new Set(r.seats.map(s => s.color));
      r.seats.forEach(s => { if (s.kind === 'open') { s.kind = 'ai'; s.diff = 'normal'; } });
      r.seats.forEach(s => { if (s.kind === 'ai') s.name = ['Blue', 'Red', 'Orange', 'White', 'Green', 'Brown'][s.color]; });
      r.seed = crypto.randomInt(1, 2 ** 31);
      r.started = true; r.log = []; r.seen = new Set(); r.sums = new Map(); r.startCfg = startPayload(r);
      for (const w of r.clients.values()) sendLog(w, r, -1);
      pushLobby(r); touched(r); break;
    }
    case 'sync': { // a browser missed something or drifted: send the log from where it asks (-1 = rebuild from the start)
      if (r.started) sendLog(ws, r, Number.isInteger(m.from) ? Math.max(-1, Math.min(m.from, r.log.length - 1)) : -1);
      break;
    }
    case 'ev': {
      const e = m.ev;
      if (!r.started || !e || typeof e !== 'object') break;
      if (e.k === 'sum') { checkSums(r, seat, e); break; }
      const mid = Math.floor(+e.mid) || 0, sid = clean(e.sid, 24);
      if (seat < 0) { send(ws, {t: 'reject', mid}); break; }
      if (mid && r.seen.has(evKey(seat, sid, mid))) break; // already in the log (sent again after a reconnect)
      const ev = {k: e.k, s: seat, n: r.log.length, mid, sid};
      if (e.k === 'cmd') ev.cmd = e.cmd; else if (e.k === 'dec') { ev.q = e.q; ev.v = e.v; } else break;
      if (r.log.length >= MAX_LOG || JSON.stringify(ev).length > 64000) { send(ws, {t: 'reject', mid}); break; } // the sender rebuilds from the log
      if (mid) r.seen.add(evKey(seat, sid, mid));
      r.log.push(ev); touched(r);
      broadcast(r, {t: 'ev', ev});
      break;
    }
    case 'chat': {
      const text = clean(m.text, 300); if (!text || seat < 0) break;
      const line = {seat, name: r.seats[seat].name, text, at: now()};
      r.chat.push(line); if (r.chat.length > 200) r.chat.shift();
      broadcast(r, {t: 'chat', line}); break;
    }
  }
}
function sendLog(ws, r, from) {
  send(ws, {t: 'hello', cfg: r.startCfg || startPayload(r), reset: from < 0, from, len: r.log.length, events: r.log.slice(from + 1), chat: r.chat.slice(-50)});
}
// Desync watchdog: at the start of every turn each browser reports a fingerprint of its game.
// When they disagree, the browsers that differ from the majority (everyone, on a tie) rebuild from the log.
function checkSums(r, seat, e) {
  const turn = Math.floor(+e.turn), h = Number(e.h) >>> 0;
  if (seat < 0 || !Number.isFinite(turn)) return;
  let t = r.sums.get(turn);
  if (!t) { t = new Map(); r.sums.set(turn, t); if (r.sums.size > 60) r.sums.delete(r.sums.keys().next().value); }
  t.set(seat, h);
  const votes = new Map();
  for (const v of t.values()) votes.set(v, (votes.get(v) || 0) + 1);
  if (votes.size < 2) return;
  const top = Math.max(...votes.values()), lead = [...votes].filter(([, c]) => c === top), ok = lead.length === 1 ? lead[0][0] : null;
  for (const [s, v] of t) {
    if (ok !== null && v === ok) continue;
    const w = r.clients.get(r.seats[s]?.cid);
    if (w?.open) send(w, {t: 'desync', turn, ok});
  }
}
function startPayload(r) {
  return {cfg: r.cfg, seed: r.seed, seats: r.seats.map(s => ({kind: s.kind, name: s.name, color: s.color, diff: s.diff})), code: r.code};
}
function drop(ws) {
  const r = ws.room && rooms.get(ws.room);
  if (!r || r.clients.get(ws.cid) !== ws) return;
  r.clients.delete(ws.cid);
  const seat = seatOf(r, ws.cid);
  if (r.host === ws.cid) reassignHost(r);
  if (r.started) broadcast(r, {t: 'presence', seat, online: false});
  else if (seat >= 0) { // in the lobby a vanished player frees the seat after a short grace period
    const cid = ws.cid;
    setTimeout(() => { if (!r.started && !r.clients.get(cid)?.open) { const i = seatOf(r, cid); if (i >= 0) { r.seats[i] = {kind: 'open', name: '', color: r.seats[i].color, diff: 'normal'}; reassignHost(r); pushLobby(r); } } }, 45000);
  }
  pushLobby(r);
}

// ---------- http ----------
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json'};
function gameFile() {
  for (const f of [path.join(PUBLIC, 'index.html'), path.join(__dirname, 'index.html')]) if (fs.existsSync(f)) return f;
  for (const d of [PUBLIC, __dirname]) { try { const h = fs.readdirSync(d).find(n => /\.html?$/i.test(n)); if (h) return path.join(d, h); } catch (e) {} }
  return null;
}
if (!gameFile()) console.log('WARNING: no game .html found. Put index.html in ./public next to server.js.');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, {'content-type': 'text/plain'}); return res.end(`ok ${rooms.size} rooms`); }
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (url.pathname === '/') file = gameFile() || file;
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, {'content-type': 'text/plain'}); return res.end('Server is running, but the game file was not found.\nPut index.html in a "public" folder next to server.js (or right beside it).'); }
    res.writeHead(200, {'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache'});
    res.end(data);
  });
});
server.on('upgrade', (req, socket) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  const ws = accept(req, socket);
  if (!ws) return;
  ws.on.message = raw => handle(ws, raw);
  ws.on.close = () => drop(ws);
});
setInterval(() => { // keep connections honest and tidy up old rooms
  for (const r of rooms.values()) {
    for (const w of r.clients.values()) { if (!w.alive) { w.socket.destroy(); continue; } w.alive = false; frame(w, 9, Buffer.alloc(0)); }
    if (!r.clients.size && now() - r.last > ROOM_TTL) rooms.delete(r.code);
    if (!r.started && !r.clients.size && now() - r.last > 1000 * 60 * 20) rooms.delete(r.code);
  }
}, 25000);
setInterval(() => { if ([...rooms.values()].some(r => r.dirty)) { rooms.forEach(r => { r.dirty = false; }); save(); } }, 30000);
load();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { save(); process.exit(0); }); // Ctrl+C keeps the games too
server.listen(PORT, () => console.log(`Hexland Settlers online on http://localhost:${PORT}`));
