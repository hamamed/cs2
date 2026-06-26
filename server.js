// CS2 Web Control Panel
// Runs on the VPS, controls the `cs2` systemd service and talks RCON to the server.
const express = require('express');
const session = require('express-session');
const { exec } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const https = require('https');

// ---------- Config (override via environment in the systemd unit) ----------
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';
const PANEL_PORT = parseInt(process.env.PANEL_PORT || '8080', 10);
const SERVICE = process.env.CS2_SERVICE || 'cs2';
const VARS_FILE = process.env.VARS_FILE || '/home/steam/cs2_server/server-vars.conf';
// CS2 may bind RCON to 127.0.0.1 OR 127.0.1.1 (Ubuntu hostname loopback). Try both.
const RCON_HOSTS = (process.env.RCON_HOST || '127.0.0.1,127.0.1.1,localhost')
  .split(',').map(s => s.trim()).filter(Boolean);

// Keys the panel is allowed to edit in server-vars.conf
const EDITABLE_KEYS = ['MAP', 'GAME_TYPE', 'GAME_MODE', 'SV_PW', 'RCON_PW', 'PORT', 'GSLT'];

// Tracks a map loaded live (workshop / changelevel) since the last (re)start,
// so the panel shows the real current map even after a browser refresh.
let liveMap = null;
// Detect when the cs2 service has (re)started by ANY means (panel, PuTTY, crash,
// auto-restart) by watching its start timestamp; reset liveMap so the tile matches reality.
let lastStartStamp = null;
async function detectRestart() {
  const st = (await sh(`systemctl show -p ActiveEnterTimestampMonotonic --value ${SERVICE}`)).out.trim();
  if (st && st !== '0') { if (lastStartStamp && st !== lastStartStamp) liveMap = null; lastStartStamp = st; }
}

// Saved-workshop-maps library (persisted on disk)
const SAVED_FILE = process.env.SAVED_FILE || path.join(__dirname, 'saved-maps.json');
function readSaved() { try { return JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8')); } catch (e) { return []; } }
function writeSaved(arr) { try { fs.writeFileSync(SAVED_FILE, JSON.stringify(arr, null, 2)); } catch (e) {} }

// Fetch a workshop item's title + preview image from the public Steam API (no key needed)
function steamWorkshopInfo(id) {
  return new Promise((resolve, reject) => {
    id = String(id).replace(/[^0-9]/g, '');
    if (!id) return reject(new Error('bad id'));
    const data = 'itemcount=1&publishedfileids%5B0%5D=' + id;
    const req = https.request({
      hostname: 'api.steampowered.com',
      path: '/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) },
      timeout: 8000,
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const f = JSON.parse(body).response.publishedfiledetails[0];
          if (!f || f.result !== 1) return reject(new Error('Workshop item not found'));
          resolve({
            id,
            title: f.title || ('Workshop ' + id),
            preview: f.preview_url || '',
            url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=' + id,
          });
        } catch (e) { reject(new Error('Steam API parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Steam API timeout')); });
    req.write(data);
    req.end();
  });
}

// ---------- Helpers: read/write the shell vars file ----------
function readVars() {
  const out = {};
  try {
    const text = fs.readFileSync(VARS_FILE, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch (e) { /* file may not exist yet */ }
  return out;
}

function writeVars(updates) {
  const current = readVars();
  const merged = { ...current, ...updates };
  const order = ['MAP', 'GAME_TYPE', 'GAME_MODE', 'PORT', 'GSLT', 'SV_PW', 'RCON_PW'];
  const keys = order.filter(k => k in merged).concat(Object.keys(merged).filter(k => !order.includes(k)));
  const content = keys.map(k => `${k}="${merged[k]}"`).join('\n') + '\n';
  fs.writeFileSync(VARS_FILE, content);
}

// ---------- Source RCON client (pure Node, no deps) ----------
// Try each candidate host; retry the next one only on connection-level errors.
async function rconExec(command) {
  let lastErr;
  for (const host of RCON_HOSTS) {
    try { return await rconExecHost(host, command); }
    catch (e) {
      lastErr = e;
      if (!/ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|timeout/i.test(e.message)) throw e;
    }
  }
  throw lastErr || new Error('RCON connect failed (is the server running?)');
}

function rconExecHost(host, command) {
  return new Promise((resolve, reject) => {
    const vars = readVars();
    const port = parseInt(vars.PORT || '27015', 10);
    const pass = vars.RCON_PW || '';
    if (!pass) return reject(new Error('No RCON password set in server-vars.conf'));

    const socket = net.connect(port, host);
    let authed = false;
    let response = '';
    let buffer = Buffer.alloc(0);
    const ID_AUTH = 1, ID_CMD = 2;
    const T_AUTH = 3, T_EXEC = 2, T_AUTH_RES = 2;

    function send(id, type, body) {
      const b = Buffer.from(body + '\0', 'utf8');
      const size = 8 + b.length + 1;
      const buf = Buffer.alloc(4 + size);
      buf.writeInt32LE(size, 0);
      buf.writeInt32LE(id, 4);
      buf.writeInt32LE(type, 8);
      b.copy(buf, 12);
      buf.writeInt8(0, 12 + b.length);
      socket.write(buf);
    }

    socket.setTimeout(6000);
    socket.on('connect', () => send(ID_AUTH, T_AUTH, pass));
    socket.on('timeout', () => { socket.destroy(); authed ? resolve(response) : reject(new Error('RCON timeout')); });
    socket.on('error', (e) => reject(e));
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 12) {
        const size = buffer.readInt32LE(0);
        if (buffer.length < size + 4) break;
        const packet = buffer.slice(4, 4 + size);
        buffer = buffer.slice(4 + size);
        const id = packet.readInt32LE(0);
        const type = packet.readInt32LE(4);
        const body = packet.slice(8, packet.length - 2).toString('utf8');
        if (!authed) {
          if (type === T_AUTH_RES) {
            if (id === -1) { socket.destroy(); return reject(new Error('RCON auth failed (wrong password)')); }
            authed = true;
            send(ID_CMD, T_EXEC, command);
          }
        } else {
          response += body;
          // give the server a beat to send any trailing packets, then close
          clearTimeout(socket._done);
          socket._done = setTimeout(() => { socket.destroy(); resolve(response); }, 250);
        }
      }
    });
  });
}

// ---------- systemctl helpers ----------
function sh(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || '') + (stderr || '') });
    });
  });
}

// ---------- App ----------
const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'cs2-panel-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }, // 8h
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ error: 'not logged in' });
}

app.post('/api/login', (req, res) => {
  const { user, pass } = req.body || {};
  if (user === PANEL_USER && pass === PANEL_PASS) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'wrong username or password' });
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get('/api/me', (req, res) => res.json({ authed: !!(req.session && req.session.authed) }));

// Service status + live info
app.get('/api/status', requireAuth, async (req, res) => {
  const active = await sh(`systemctl is-active ${SERVICE}`);
  const running = active.out.trim() === 'active';
  if (!running) { liveMap = null; lastStartStamp = null; }
  else await detectRestart();
  let info = '';
  if (running) {
    try { info = await rconExec('status'); } catch (e) { info = '(server up, RCON not ready: ' + e.message + ')'; }
  }
  res.json({ running, state: active.out.trim(), vars: readVars(), info, liveMap });
});

// Start / stop / restart
app.post('/api/control', requireAuth, async (req, res) => {
  const action = (req.body && req.body.action) || '';
  if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'bad action' });
  const r = await sh(`systemctl ${action} ${SERVICE}`);
  liveMap = null; // (re)start/stop reverts to the configured map
  res.json({ ok: r.ok, out: r.out || `${action} sent` });
});

// Raw RCON command
app.post('/api/rcon', requireAuth, async (req, res) => {
  const cmd = (req.body && req.body.cmd) || '';
  if (!cmd.trim()) return res.status(400).json({ error: 'empty command' });
  try {
    const out = await rconExec(cmd);
    // track map-changing commands so the Current Map tile stays accurate
    const mws = cmd.match(/^\s*host_workshop_map\s+(\d+)/i);
    const mmap = cmd.match(/^\s*(?:changelevel|map)\s+(\S+)/i);
    if (mws) liveMap = 'workshop ' + mws[1];
    else if (mmap) liveMap = mmap[1];
    res.json({ ok: true, out });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// One-click practice toggle
app.post('/api/practice', requireAuth, async (req, res) => {
  try { res.json({ ok: true, out: await rconExec('exec prac') }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Quick live map change (no restart) — works within compatible modes; clears any workshop map
app.post('/api/map', requireAuth, async (req, res) => {
  const map = (req.body && req.body.map || '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!map) return res.status(400).json({ error: 'bad map' });
  writeVars({ MAP: map, WORKSHOP: '' });
  liveMap = map;
  try { res.json({ ok: true, out: await rconExec('changelevel ' + map) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Save settings (map/mode/passwords/workshop) and optionally restart to apply
app.post('/api/settings', requireAuth, async (req, res) => {
  const body = req.body || {};
  const updates = {};
  for (const k of EDITABLE_KEYS) if (k in body && body[k] !== '') updates[k] = String(body[k]).replace(/"/g, '');
  // Workshop: explicit ID sets it; choosing a normal map clears it
  if ('WORKSHOP' in body) updates.WORKSHOP = String(body.WORKSHOP).replace(/[^0-9]/g, '');
  else if ('MAP' in body) updates.WORKSHOP = '';
  writeVars(updates);
  let out = 'Saved.';
  if (body._restart) { liveMap = null; const r = await sh(`systemctl restart ${SERVICE}`); out += r.ok ? ' Restarting…' : ' (restart failed: ' + r.out + ')'; }
  res.json({ ok: true, out });
});

// Workshop item info (title + preview image) from Steam
app.get('/api/wsinfo', requireAuth, async (req, res) => {
  try { res.json({ ok: true, info: await steamWorkshopInfo(req.query.id || '') }); }
  catch (e) { res.status(404).json({ ok: false, error: e.message }); }
});

// Saved-maps library
app.get('/api/saved', requireAuth, (req, res) => res.json({ ok: true, maps: readSaved() }));

app.post('/api/saved', requireAuth, async (req, res) => {
  const id = String((req.body && req.body.id) || '').replace(/[^0-9]/g, '');
  if (!id) return res.status(400).json({ error: 'bad id' });
  let info;
  try { info = await steamWorkshopInfo(id); } catch (e) { return res.status(404).json({ ok: false, error: e.message }); }
  const maps = readSaved();
  if (!maps.find(m => m.id === id)) { maps.push(info); writeSaved(maps); }
  res.json({ ok: true, maps });
});

app.post('/api/saved/remove', requireAuth, (req, res) => {
  const id = String((req.body && req.body.id) || '').replace(/[^0-9]/g, '');
  const maps = readSaved().filter(m => m.id !== id);
  writeSaved(maps);
  res.json({ ok: true, maps });
});

// Recent server logs
app.get('/api/logs', requireAuth, async (req, res) => {
  const r = await sh(`journalctl -u ${SERVICE} -n 120 --no-pager`);
  res.json({ ok: true, out: r.out });
});

// ---------- PUBLIC (no auth) read-only status ----------
const wsInfoCache = {};
async function cachedWsInfo(id) { if (wsInfoCache[id]) return wsInfoCache[id]; const i = await steamWorkshopInfo(id); wsInfoCache[id] = i; return i; }
function parsePlayersServer(info) {
  if (!info) return null;
  let m = info.match(/players\s*:\s*(\d+)\s*humans?,\s*(\d+)\s*bots?/i);
  if (m) return { humans: +m[1], bots: +m[2] };
  m = info.match(/(\d+)\s*\/\s*(\d+)\s*players/i);
  if (m) return { humans: +m[1], max: +m[2], bots: 0 };
  return null;
}

app.get('/api/public', async (req, res) => {
  const active = await sh(`systemctl is-active ${SERVICE}`);
  const running = active.out.trim() === 'active';
  if (!running) { liveMap = null; lastStartStamp = null; } else await detectRestart();
  const v = readVars();
  const isWs = !!(liveMap && liveMap.indexOf('workshop') === 0);
  const wsId = isWs ? liveMap.replace(/\D/g, '') : '';
  let players = null, mapInfo = null;
  if (running) { try { players = parsePlayersServer(await rconExec('status')); } catch (e) {} }
  if (wsId) { try { mapInfo = await cachedWsInfo(wsId); } catch (e) {} }
  res.json({
    running,
    port: v.PORT || '27015',
    password: v.SV_PW || '',
    mapName: liveMap || v.MAP || '',
    isWorkshop: isWs,
    mapInfo, // {title, preview, url} or null
    game_type: v.GAME_TYPE, game_mode: v.GAME_MODE,
    players,
  });
});

// serve the public page at a clean path too
app.get('/status', (req, res) => res.sendFile(path.join(__dirname, 'public', 'status.html')));

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PANEL_PORT, () => console.log(`CS2 panel listening on http://0.0.0.0:${PANEL_PORT}`));
