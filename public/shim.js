/* window.claude.use("room" | "db" | "user") arayüzünü kendi sunucumuza bağlayan uyumluluk katmanı.
   index.html içinde oyunun kendi <script> etiketinden ÖNCE yüklenmelidir. */
(function () {
  'use strict';

  function randomId(len) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var out = '';
    var buf = new Uint32Array(len);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(buf);
    else for (var j = 0; j < len; j++) buf[j] = Math.floor(Math.random() * 4294967296);
    for (var i = 0; i < len; i++) out += chars[buf[i] % chars.length];
    return out;
  }

  var memoryId = null;
  var user = {
    id: function () {
      try {
        var v = localStorage.getItem('oyuncuId');
        if (v && /^[A-Za-z0-9_-]{8,64}$/.test(v)) return v;
        v = randomId(24);
        localStorage.setItem('oyuncuId', v);
        return v;
      } catch (e) {
        if (!memoryId) memoryId = randomId(24);
        return memoryId;
      }
    }
  };

  function httpJson(method, url, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
        return data;
      });
    });
  }

  function collection(name) {
    if (name !== 'lb') {
      return {
        get: function () { return Promise.resolve({ docs: [] }); },
        doc: function () { return { set: function () { return Promise.resolve(); }, get: function () { return Promise.resolve(null); } }; }
      };
    }
    return {
      get: function () {
        return httpJson('GET', '/api/lb').then(function (rows) {
          return {
            docs: (rows || []).map(function (row) {
              return { id: row.id, data: function () { return row.data; } };
            })
          };
        });
      },
      doc: function (id) {
        return {
          set: function (obj) {
            return httpJson('PUT', '/api/lb/' + encodeURIComponent(id), obj).then(function () {});
          }
        };
      }
    };
  }
  var db = { collection: collection };

  function wsUrl() {
    return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
  }

  var room = {
    join: function (roomName) {
      var ws = null;
      var myId = null;
      var lastPeers = [];
      var handlers = [];
      var myPresence = {};
      var closed = false;
      var reconnectTimer = null;
      var pending = []; // açılmadan önce gönderilecek mesajlar
      var firstResolve, firstReject;
      var firstReady = new Promise(function (res, rej) { firstResolve = res; firstReject = rej; });
      var settled = false;

      function decorate(list) {
        return (list || []).map(function (p) {
          return { peer: p.peer, isMe: p.peer === myId, presence: p.presence || {} };
        });
      }

      function send(obj) {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
        else pending.push(obj);
      }

      function connect() {
        ws = new WebSocket(wsUrl());
        ws.onopen = function () {
          // join'i presence ile birlikte gönder: yeniden bağlanınca son durum geri gelir
          ws.send(JSON.stringify({ type: 'join', room: roomName, presence: myPresence }));
          var q = pending; pending = [];
          q.forEach(function (m) { if (m.type !== 'presence') ws.send(JSON.stringify(m)); });
          if (q.some(function (m) { return m.type === 'presence'; })) {
            ws.send(JSON.stringify({ type: 'presence', patch: myPresence }));
          }
        };
        ws.onmessage = function (ev) {
          var msg;
          try { msg = JSON.parse(ev.data); } catch (e) { return; }
          if (msg.type === 'welcome') { myId = msg.peer; return; }
          if (msg.type === 'peers') {
            lastPeers = decorate(msg.peers);
            if (!settled) { settled = true; firstResolve(); }
            var evt = {
              peers: lastPeers,
              joined: decorate(msg.joined),
              left: decorate(msg.left),
              updated: decorate(msg.updated)
            };
            handlers.slice().forEach(function (h) {
              try { h(evt); } catch (e) { console.error(e); }
            });
            return;
          }
          if (msg.type === 'error') {
            console.warn('oda hatası:', msg.error);
            if (!settled && (msg.error === 'full' || msg.error === 'room')) {
              settled = true; closed = true;
              firstReject(new Error(msg.error === 'full' ? 'Oda dolu (en fazla 30 kişi).' : 'Geçersiz oda adı.'));
              try { ws.close(); } catch (e) {}
            }
          }
        };
        ws.onclose = function () {
          if (closed) return;
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connect, 2000);
        };
        ws.onerror = function () { /* onclose yeniden bağlanır */ };
      }

      var api = {
        peers: function () { return lastPeers; },
        presence: function (patch) {
          patch = patch || {};
          for (var k in patch) {
            if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
            if (patch[k] === null) delete myPresence[k];
            else myPresence[k] = patch[k];
          }
          if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'presence', patch: patch }));
          else pending.push({ type: 'presence' });
          return Promise.resolve();
        },
        onPeers: function (handler) {
          handlers.push(handler);
          return function () {
            var i = handlers.indexOf(handler);
            if (i >= 0) handlers.splice(i, 1);
          };
        },
        leave: function () {
          closed = true;
          clearTimeout(reconnectTimer);
          try {
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'leave' }));
            if (ws) ws.close();
          } catch (e) {}
          return Promise.resolve();
        }
      };

      connect();
      // İlk oyuncu listesi gelince (en geç 5 sn) oda nesnesini döndür
      var timeout = new Promise(function (res) { setTimeout(res, 5000); });
      return Promise.race([firstReady, timeout]).then(function () { return api; });
    }
  };

  var caps = { user: user, db: db, room: room };
  window.claude = window.claude || {};
  window.claude.use = function (name) {
    return Object.prototype.hasOwnProperty.call(caps, name) ? caps[name] : null;
  };
})();
