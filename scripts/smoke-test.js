// Sunucuyu geçici bir portta başlatıp API, statik dosya ve WebSocket oda davranışını test eder.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');
const PORT = 3999; const B = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oyun-'));
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, HOST: '127.0.0.1', DATA_DIR: dataDir }, stdio: 'inherit' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`); const q = []; let w = null;
  ws.on('message', (d) => { const m = JSON.parse(d); if (w) { const f = w; w = null; f(m); } else q.push(m); });
  ws.next = () => q.length ? Promise.resolve(q.shift()) : new Promise((r) => { w = r; });
  return new Promise((r) => ws.on('open', () => r(ws)));
}
(async () => {
  try {
    await wait(500);
    let r = await fetch(B + '/shim.js'); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
    r = await fetch(B + '/%2e%2e/server.js'); assert.ok([403, 404].includes(r.status), 'traversal ' + r.status);
    r = await fetch(B + '/api/lb'); assert.deepEqual(await r.json(), []);
    const put = (id, b) => fetch(B + '/api/lb/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    r = await put('oyuncu12345', { name: '  Ayşe Uzunisimlikız ', lv: 1, lang: 'İngilizce', solved: 30 }); assert.equal(r.status, 200);
    r = await put('kisa', { name: 'x', lv: 1, lang: 'x', solved: 1 }); assert.equal(r.status, 400);
    r = await put('oyuncu12345', { name: 'x', lv: 3, lang: 'x', solved: 1 }); assert.equal(r.status, 400);
    r = await fetch(B + '/api/lb/oyuncu12345', { method: 'PUT', body: 'x'.repeat(3000) }); assert.equal(r.status, 413);
    r = await fetch(B + '/api/lb'); const rows = await r.json();
    assert.equal(rows[0].data.name, 'Ayşe Uzunisiml'); assert.equal(rows[0].id, 'oyuncu12345');
    await wait(200); assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, 'leaderboard.json'))).oyuncu12345);
    let last; for (let i = 0; i < 30; i++) last = await put('oyuncu12345', { name: 'a', lv: 0, lang: 'x', solved: i });
    assert.equal(last.status, 429, 'rate limit');

    const a = await client(); const wa = await a.next(); assert.equal(wa.type, 'welcome');
    a.send(JSON.stringify({ type: 'join', room: 'oda-ABC' }));
    let m = await a.next(); assert.equal(m.peers.length, 1);
    const b = await client(); const wb = await b.next();
    b.send(JSON.stringify({ type: 'join', room: 'oda-ABC', presence: { name: 'Mehmet' } }));
    m = await a.next(); assert.equal(m.peers.length, 2); assert.equal(m.joined[0].peer, wb.peer);
    await b.next();
    b.send(JSON.stringify({ type: 'presence', patch: { score: 5, name: 'BirÇokUzunİsimlerVar' } }));
    m = await a.next(); assert.equal(m.updated[0].presence.score, 5); assert.equal(m.updated[0].presence.name.length, 14);
    await b.next();
    b.send(JSON.stringify({ type: 'presence', patch: { score: null } }));
    m = await a.next(); assert.ok(!('score' in m.updated[0].presence)); await b.next();
    b.close(); m = await a.next(); assert.equal(m.left[0].peer, wb.peer); assert.equal(m.peers.length, 1);
    a.send(JSON.stringify({ type: 'join', room: 'kötü oda!' })); m = await a.next(); assert.equal(m.type, 'error');
    a.close();
    console.log('TÜM TESTLER GEÇTİ');
    srv.kill(); process.exit(0);
  } catch (e) { console.error('TEST BAŞARISIZ:', e); srv.kill(); process.exit(1); }
})();
