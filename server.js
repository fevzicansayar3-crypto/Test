'use strict';
// Bütün Dilleri Öğreniyoruz — statik dosya + sıralama API'si + WebSocket oda sunucusu
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LB_FILE = path.join(DATA_DIR, 'leaderboard.json');

const MAX_BODY = 2 * 1024;
const MAX_PRESENCE = 2 * 1024;
const MAX_ROOM_SIZE = 30;
const WRITE_LIMIT_PER_MIN = 30;
const PING_INTERVAL_MS = 30 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------- sıralama verisi
fs.mkdirSync(DATA_DIR, { recursive: true });
let leaderboard = {};
try {
  const parsed = JSON.parse(fs.readFileSync(LB_FILE, 'utf8'));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) leaderboard = parsed;
} catch (e) {
  if (e.code !== 'ENOENT') console.error('leaderboard.json okunamadı, boş başlıyor:', e.message);
}

let saving = false;
let saveAgain = false;
async function saveLeaderboard() {
  if (saving) { saveAgain = true; return; }
  saving = true;
  try {
    do {
      saveAgain = false;
      const tmp = LB_FILE + '.' + process.pid + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(leaderboard));
      await fs.promises.rename(tmp, LB_FILE);
    } while (saveAgain);
  } catch (e) {
    console.error('leaderboard kaydedilemedi:', e.message);
  } finally {
    saving = false;
  }
}

// IP başına dakikalık yazma sınırı
const writeHits = new Map(); // ip -> [timestamps]
function allowWrite(ip) {
  const now = Date.now();
  const hits = (writeHits.get(ip) || []).filter((t) => now - t < 60_000);
  if (hits.length >= WRITE_LIMIT_PER_MIN) { writeHits.set(ip, hits); return false; }
  hits.push(now);
  writeHits.set(ip, hits);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of writeHits) {
    if (!hits.some((t) => now - t < 60_000)) writeHits.delete(ip);
  }
}, 60_000).unref();

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
function validateEntry(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { name, lv, lang, solved } = body;
  if (typeof name !== 'string') return null;
  const n = name.trim().slice(0, 14);
  if (!n) return null;
  if (![0, 1, 2].includes(lv)) return null;
  if (typeof lang !== 'string' || lang.length > 20) return null;
  if (!Number.isInteger(solved) || solved < 0 || solved > 100000) return null;
  return { name: n, lv, lang, solved };
}

// ---------------------------------------------------------------- HTTP yardımcıları
function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error('too large'), { status: 413 });
    if (Number(req.headers['content-length']) > limit) {
      req.resume(); // gövdeyi okuyup at, yanıt düzgün gitsin
      return reject(tooLarge());
    }
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; reject(tooLarge()); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400); res.end('Bad Request'); return;
  }
  if (rel.includes('\0')) { res.writeHead(400); res.end('Bad Request'); return; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize(rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bulunamadı'); return; }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Content-Length': st.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------------------------------------------------------------- HTTP sunucusu
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400); res.end(); return;
  }
  const p = url.pathname;

  try {
    if (p === '/api/lb') {
      if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return sendJson(res, 405, { error: 'method' }); }
      return sendJson(res, 200, Object.entries(leaderboard).map(([id, data]) => ({ id, data })));
    }

    const m = p.match(/^\/api\/lb\/([^/]+)$/);
    if (m) {
      if (req.method !== 'PUT') { res.setHeader('Allow', 'PUT'); return sendJson(res, 405, { error: 'method' }); }
      const id = m[1];
      if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id' });
      if (!allowWrite(clientIp(req))) return sendJson(res, 429, { error: 'rate' });
      let body;
      try {
        body = JSON.parse(await readBody(req, MAX_BODY));
      } catch (e) {
        return sendJson(res, e.status || 400, { error: e.status === 413 ? 'too large' : 'json' });
      }
      const entry = validateEntry(body);
      if (!entry) return sendJson(res, 400, { error: 'invalid' });
      leaderboard[id] = entry;
      saveLeaderboard();
      return sendJson(res, 200, { ok: true });
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    serveStatic(req, res, p);
  } catch (e) {
    console.error('istek hatası:', e);
    if (!res.headersSent) sendJson(res, 500, { error: 'server' });
    else res.end();
  }
});

// ---------------------------------------------------------------- canlı odalar
/** rooms: Map<odaAdı, Map<peerId, { presence, ws }>> */
const rooms = new Map();
const ROOM_RE = /^[A-Za-z0-9-]{1,40}$/;

function peerList(room) {
  return [...room.entries()].map(([peer, v]) => ({ peer, presence: v.presence }));
}

function broadcast(roomName, change) {
  const room = rooms.get(roomName);
  if (!room) return;
  const msg = JSON.stringify({
    type: 'peers',
    peers: peerList(room),
    joined: change.joined || [],
    left: change.left || [],
    updated: change.updated || [],
  });
  for (const { ws } of room.values()) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

function sanitizePresence(obj) {
  if (obj.name !== undefined && obj.name !== null) obj.name = String(obj.name).slice(0, 14);
  return obj;
}

function leaveRoom(ws) {
  const roomName = ws.roomName;
  if (!roomName) return;
  ws.roomName = null;
  const room = rooms.get(roomName);
  if (!room) return;
  const entry = room.get(ws.peerId);
  if (!entry || entry.ws !== ws) return;
  room.delete(ws.peerId);
  const leftPeer = { peer: ws.peerId, presence: entry.presence };
  if (room.size === 0) rooms.delete(roomName);
  else broadcast(roomName, { left: [leftPeer] });
}

function sendErr(ws, error) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', error }));
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { pathname = ''; }
  if (pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ws.peerId = crypto.randomBytes(9).toString('base64url');
  ws.roomName = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ type: 'welcome', peer: ws.peerId }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return sendErr(ws, 'json'); }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') {
      const roomName = msg.room;
      if (typeof roomName !== 'string' || !ROOM_RE.test(roomName)) return sendErr(ws, 'room');
      if (ws.roomName === roomName) return broadcast(roomName, {});
      leaveRoom(ws);
      let room = rooms.get(roomName);
      if (!room) { room = new Map(); rooms.set(roomName, room); }
      if (room.size >= MAX_ROOM_SIZE) {
        if (room.size === 0) rooms.delete(roomName);
        return sendErr(ws, 'full');
      }
      let presence = {};
      if (msg.presence && typeof msg.presence === 'object' && !Array.isArray(msg.presence)
          && Buffer.byteLength(JSON.stringify(msg.presence)) <= MAX_PRESENCE) {
        presence = sanitizePresence(stripNulls({ ...msg.presence }));
      }
      room.set(ws.peerId, { presence, ws });
      ws.roomName = roomName;
      broadcast(roomName, { joined: [{ peer: ws.peerId, presence }] });
      return;
    }

    if (msg.type === 'presence') {
      const room = ws.roomName && rooms.get(ws.roomName);
      if (!room) return sendErr(ws, 'not joined');
      const patch = msg.patch;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return sendErr(ws, 'patch');
      const entry = room.get(ws.peerId);
      const next = stripNulls({ ...entry.presence, ...patch });
      sanitizePresence(next);
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_PRESENCE) return sendErr(ws, 'presence too large');
      entry.presence = next;
      broadcast(ws.roomName, { updated: [{ peer: ws.peerId, presence: next }] });
      return;
    }

    if (msg.type === 'leave') {
      leaveRoom(ws);
      return;
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => {});
});

function stripNulls(obj) {
  for (const k of Object.keys(obj)) if (obj[k] === null) delete obj[k];
  return obj;
}

const pingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* yoksay */ }
  }
}, PING_INTERVAL_MS);

server.listen(PORT, HOST, () => {
  console.log(`Oyun sunucusu http://${HOST}:${PORT} adresinde çalışıyor`);
});

function shutdown() {
  clearInterval(pingTimer);
  for (const ws of wss.clients) ws.close(1001, 'server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
