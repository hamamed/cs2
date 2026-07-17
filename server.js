// CS2 Web Control Panel
// Runs on the VPS, controls the `cs2` systemd service and talks RCON to the server.
const express = require('express');
const session = require('express-session');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const https = require('https');
const dgram = require('dgram');
const os = require('os');

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

// ---------- Server-update (SteamCMD) config ----------
// CS2 dedicated server = Steam app 730. Updating downloads game files, so the
// server must be stopped first, then restarted once SteamCMD finishes.
// The panel usually runs as root; SteamCMD must run as the game user (`steam`)
// so downloaded files keep the right ownership. Override any of these via the
// systemd unit, or set UPDATE_CMD directly for a fully custom command.
const STEAM_USER = process.env.STEAM_USER || 'steam';
const CS2_DIR = process.env.CS2_DIR || '/home/steam/cs2_server';

// Find the SteamCMD executable. Honour an explicit STEAMCMD override, otherwise
// probe the usual spots (self-installed script, or the apt `steamcmd` package),
// and finally fall back to `command -v steamcmd` on PATH.
function resolveSteamcmd() {
  if (process.env.STEAMCMD) return process.env.STEAMCMD;
  const home = `/home/${STEAM_USER}`;
  const candidates = [
    `${home}/steamcmd/steamcmd.sh`,
    `${home}/Steam/steamcmd.sh`,
    `${home}/.steam/steamcmd/steamcmd.sh`,
    '/home/steam/steamcmd/steamcmd.sh',
    '/usr/games/steamcmd',
    '/usr/local/bin/steamcmd',
    '/usr/bin/steamcmd',
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  const onPath = require('child_process').execSync('command -v steamcmd 2>/dev/null || true', { shell: '/bin/bash' })
    .toString().trim();
  return onPath || null;
}

// The full update command. A UPDATE_CMD env override wins; otherwise build one
// that runs SteamCMD as the game user so downloaded files keep the right owner.
const UPDATE_TRIES = parseInt(process.env.UPDATE_TRIES || '3', 10);
function buildUpdateCmd(steamcmd) {
  if (process.env.UPDATE_CMD) return process.env.UPDATE_CMD;
  // SteamCMD frequently exits with a transient "state 0x2xx" error (interrupted
  // download, throttling) and succeeds on a retry, so loop until it reports
  // "Success! App '730' fully installed" or we run out of attempts.
  const steam = `${steamcmd} +force_install_dir ${CS2_DIR} +login anonymous +app_update 730 validate +quit`;
  const loop =
    `L=$(mktemp); for i in $(seq 1 ${UPDATE_TRIES}); do ` +
    `echo "[panel] SteamCMD attempt $i of ${UPDATE_TRIES}…"; ` +
    `${steam} 2>&1 | tee "$L"; ` +               // stream live AND capture for the success check
    `grep -q "Success! App .730. fully installed" "$L" && { rm -f "$L"; exit 0; }; ` +
    `echo "[panel] attempt $i did not complete; retrying in 5s…"; sleep 5; ` +
    `done; rm -f "$L"; exit 1`;
  // Only switch users if we aren't already the steam user (panel usually runs as root).
  return `if [ "$(id -un)" = "${STEAM_USER}" ]; then ${loop}; else su - ${STEAM_USER} -c '${loop.replace(/'/g, "'\\''")}'; fi`;
}

// In-memory state of the currently running / last update job.
let updateJob = null; // { running, done, ok, startedAt, log:[] }

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

// ---------- A2S server query (reliable player/bot count + map) ----------
function a2sInfoHost(host, port) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let settled = false;
    const REQ = Buffer.concat([Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0x54]), Buffer.from('Source Engine Query\0', 'latin1')]);
    const send = (challenge) => sock.send(challenge ? Buffer.concat([REQ, challenge]) : REQ, port, host);
    const timer = setTimeout(() => finish(new Error('A2S timeout')), 2500);
    function finish(err, val) { if (settled) return; settled = true; clearTimeout(timer); try { sock.close(); } catch (e) {} err ? reject(err) : resolve(val); }
    sock.on('error', finish);
    sock.on('message', (msg) => {
      try {
        const type = msg.readUInt8(4);
        if (type === 0x41) { send(msg.slice(5, 9)); return; } // challenge -> resend
        if (type === 0x49) {
          let o = 5; o++; // skip protocol
          const readStr = () => { const s = o; while (o < msg.length && msg[o] !== 0) o++; const str = msg.slice(s, o).toString('utf8'); o++; return str; };
          const name = readStr(); const map = readStr(); readStr(); readStr(); // folder, game
          o += 2; // appid
          const players = msg.readUInt8(o++); const maxplayers = msg.readUInt8(o++); const bots = msg.readUInt8(o++);
          finish(null, { name, map, players, maxplayers, bots });
        }
      } catch (e) { finish(e); }
    });
    send();
  });
}
async function a2sInfo() {
  const port = parseInt(readVars().PORT || '27015', 10);
  const hosts = Array.from(new Set([...RCON_HOSTS, '127.0.0.1']));
  let lastErr;
  for (const host of hosts) { try { return await a2sInfoHost(host, port); } catch (e) { lastErr = e; } }
  throw lastErr || new Error('A2S failed');
}

// A2S_PLAYER — list of players (name, score, seconds connected)
function a2sPlayersHost(host, port) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let settled = false, challenge = Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]);
    const send = () => sock.send(Buffer.concat([Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0x55]), challenge]), port, host);
    const timer = setTimeout(() => finish(new Error('A2S timeout')), 2500);
    function finish(err, val) { if (settled) return; settled = true; clearTimeout(timer); try { sock.close(); } catch (e) {} err ? reject(err) : resolve(val); }
    sock.on('error', finish);
    sock.on('message', (msg) => {
      try {
        const type = msg.readUInt8(4);
        if (type === 0x41) { challenge = msg.slice(5, 9); send(); return; }
        if (type === 0x44) {
          let o = 5; const count = msg.readUInt8(o++); const players = [];
          for (let i = 0; i < count; i++) {
            o++; // index
            const s = o; while (o < msg.length && msg[o] !== 0) o++; const name = msg.slice(s, o).toString('utf8'); o++;
            const score = msg.readInt32LE(o); o += 4;
            const duration = msg.readFloatLE(o); o += 4;
            players.push({ name, score, duration });
          }
          finish(null, players);
        }
      } catch (e) { finish(e); }
    });
    send();
  });
}
async function a2sPlayers() {
  const port = parseInt(readVars().PORT || '27015', 10);
  const hosts = Array.from(new Set([...RCON_HOSTS, '127.0.0.1']));
  let lastErr;
  for (const host of hosts) { try { return await a2sPlayersHost(host, port); } catch (e) { lastErr = e; } }
  throw lastErr || new Error('A2S failed');
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
  let info = '', a2s = null, counts = null;
  if (running) {
    try { a2s = await a2sInfo(); } catch (e) {}
    try { info = await rconExec('status'); } catch (e) { info = '(server up, RCON not ready: ' + e.message + ')'; }
    counts = parsePlayersServer(info); // accurate humans/bots from the "players :" line
  }
  res.json({ running, state: active.out.trim(), vars: readVars(), info, liveMap, a2s, counts });
});

// Start / stop / restart
app.post('/api/control', requireAuth, async (req, res) => {
  const action = (req.body && req.body.action) || '';
  if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'bad action' });
  const r = await sh(`systemctl ${action} ${SERVICE}`);
  liveMap = null; // (re)start/stop reverts to the configured map
  res.json({ ok: r.ok, out: r.out || `${action} sent` });
});

// Update the CS2 server files via SteamCMD (app 730).
// Stops the server, runs SteamCMD in the background streaming output into
// updateJob.log, then restarts the server. Poll /api/update/status for progress.
app.post('/api/update', requireAuth, async (req, res) => {
  if (updateJob && updateJob.running) return res.json({ ok: true, already: true });
  updateJob = { running: true, done: false, ok: false, startedAt: Date.now(), log: [] };
  const push = (chunk) => {
    for (const ln of String(chunk).split(/\r?\n/)) if (ln !== '') updateJob.log.push(ln);
    if (updateJob.log.length > 600) updateJob.log = updateJob.log.slice(-600);
  };
  const steamcmd = resolveSteamcmd();
  if (!steamcmd) {
    push('[panel] SteamCMD not found. Install it or set STEAMCMD=/path/to/steamcmd.sh');
    push('[panel]   e.g.  apt install steamcmd   — or point STEAMCMD at your steamcmd.sh');
    updateJob.running = false; updateJob.done = true; updateJob.ok = false;
    return res.json({ ok: false, error: 'SteamCMD not found' });
  }
  const updateCmd = buildUpdateCmd(steamcmd);
  push('[panel] Using SteamCMD at: ' + steamcmd);
  try {
    const d = (await sh(`df -h ${CS2_DIR} 2>/dev/null || df -h /`)).out.trim().split('\n').pop().split(/\s+/);
    push(`[panel] Free disk on install volume: ${d[3]} available (of ${d[1]}, ${d[4]} used). A CS2 update needs several GB free.`);
  } catch (e) {}
  push('[panel] Stopping CS2 server before update…');
  await sh(`systemctl stop ${SERVICE}`);
  liveMap = null; lastStartStamp = null;
  push('[panel] Running SteamCMD update for app 730 — this can take several minutes.');
  let child;
  try {
    child = spawn('bash', ['-lc', updateCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    push('[panel] Could not launch SteamCMD: ' + e.message);
    updateJob.running = false; updateJob.done = true; updateJob.ok = false;
    return res.json({ ok: false, error: e.message });
  }
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (e) => push('[panel] SteamCMD error: ' + e.message));
  child.on('close', async (code) => {
    push('[panel] SteamCMD finished (exit code ' + code + ').');
    const joined = updateJob.log.join('\n');
    const stateM = joined.match(/state is (0x[0-9a-fA-F]+)/);
    if (code !== 0 && stateM) {
      push(`[panel] SteamCMD reported an incomplete update (${stateM[1]}). Common causes:`);
      push('[panel]   • Not enough free disk space — see the free-disk line above, then use "Clear workshop downloads".');
      push('[panel]   • Low RAM — the update can be killed on small VPSes; add swap or retry when idle.');
      push('[panel]   • Steam content servers throttling — just run Update again in a few minutes.');
    }
    push('[panel] Starting CS2 server…');
    const r = await sh(`systemctl start ${SERVICE}`);
    push(r.ok ? '[panel] Server started.' : '[panel] Server start failed: ' + r.out);
    updateJob.ok = (code === 0);
    updateJob.running = false;
    updateJob.done = true;
  });
  res.json({ ok: true, started: true });
});

// Progress of the current / last update job
app.get('/api/update/status', requireAuth, (req, res) => {
  if (!updateJob) return res.json({ ok: true, running: false, done: false, log: '' });
  res.json({
    ok: true,
    running: updateJob.running,
    done: updateJob.done,
    success: updateJob.ok,
    startedAt: updateJob.startedAt,
    log: updateJob.log.join('\n'),
  });
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

// Parse the RCON `status` player table (gives real names + userid + BOT flag)
function parseStatusPlayers(info) {
  if (!info) return null;
  const out = [];
  for (const ln of info.split(/\r?\n/)) {
    if (!/["']/.test(ln)) continue;                 // player rows have a quoted name
    if (/hostname|version|players\s*:|map\s*:|udp\/ip|spawngroup/i.test(ln)) continue;
    const nameM = ln.match(/["']([^"']{1,32})["']/);
    if (!nameM) continue;
    const idM = ln.match(/^\s*#?\s*(\d+)/);
    out.push({ userid: idM ? idM[1] : null, name: nameM[1], bot: /\bBOT\b/i.test(ln) });
  }
  return out.length ? out : null;
}

// Player list — prefer RCON status (real names + kickable userids), fall back to A2S
app.get('/api/players', requireAuth, async (req, res) => {
  let a2s = null;
  try { a2s = await a2sInfo(); } catch (e) {}
  try {
    const parsed = parseStatusPlayers(await rconExec('status'));
    if (parsed && parsed.length) {
      return res.json({ ok: true, source: 'status', players: parsed, bots: parsed.filter(p => p.bot).length, total: parsed.length });
    }
  } catch (e) {}
  try {
    const list = await a2sPlayers();
    res.json({ ok: true, source: 'a2s', players: list.map(p => ({ name: p.name, score: p.score, duration: p.duration })), bots: a2s ? a2s.bots : null, total: a2s ? a2s.players : list.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Kick / ban a player
app.post('/api/kick', requireAuth, async (req, res) => {
  const b = req.body || {};
  const cmd = b.userid ? ('kickid ' + String(b.userid).replace(/\D/g, ''))
    : ('kick "' + String(b.name || '').replace(/["\r\n;]/g, '') + '"');
  try { res.json({ ok: true, out: await rconExec(cmd) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/ban', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.userid) return res.status(400).json({ error: 'need userid' });
  const mins = parseInt(b.minutes || '0', 10) || 0;
  try { res.json({ ok: true, out: await rconExec('banid ' + mins + ' ' + String(b.userid).replace(/\D/g, '') + ' kick') }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Server health: CPU / RAM / disk
app.get('/api/health', requireAuth, async (req, res) => {
  let diskPct = null, diskUsed = '', diskTotal = '';
  try { const d = (await sh('df -h /')).out.trim().split('\n').pop().split(/\s+/); diskTotal = d[1]; diskUsed = d[2]; diskPct = parseInt(d[4]); } catch (e) {}
  let memPct = null, memUsed = 0, memTotal = os.totalmem();
  try {
    const line = (await sh('free -b')).out.split('\n').find(l => /^Mem:/.test(l)).split(/\s+/);
    memTotal = +line[1]; const avail = +line[6]; memUsed = memTotal - (avail || (memTotal - os.freemem()));
  } catch (e) { memUsed = memTotal - os.freemem(); }
  memPct = Math.round(memUsed / memTotal * 100);
  const cpus = os.cpus().length, load = os.loadavg()[0];
  res.json({
    ok: true, cpuPct: Math.min(100, Math.round(load / cpus * 100)), load: +load.toFixed(2), cpus,
    memPct, memUsedGB: (memUsed / 1073741824).toFixed(1), memTotalGB: (memTotal / 1073741824).toFixed(1),
    diskPct, diskUsed, diskTotal,
  });
});

// One-click: clear old workshop downloads + trim logs to free disk
app.post('/api/cleardownloads', requireAuth, async (req, res) => {
  await sh('rm -rf /home/steam/cs2_server/steamapps/workshop/downloads/* 2>/dev/null');
  await sh('rm -rf /home/steam/.steam/steam/steamapps/workshop/downloads/* 2>/dev/null');
  await sh('journalctl --vacuum-size=200M >/dev/null 2>&1');
  let diskPct = null, diskUsed = '', diskTotal = '';
  try { const d = (await sh('df -h /')).out.trim().split('\n').pop().split(/\s+/); diskTotal = d[1]; diskUsed = d[2]; diskPct = parseInt(d[4]); } catch (e) {}
  res.json({ ok: true, diskPct, diskUsed, diskTotal });
});

// Demos (GOTV recordings) — list + download
const DEMO_DIRS = (process.env.DEMO_DIRS || '/home/steam/cs2_server/game/csgo,/home/steam/cs2_server/game/csgo/replays').split(',');
// Approved demos = published publicly on the share page
const APPROVED_FILE = process.env.APPROVED_FILE || path.join(__dirname, 'approved-demos.json');
function readApproved() { try { return JSON.parse(fs.readFileSync(APPROVED_FILE, 'utf8')); } catch (e) { return []; } }
function writeApproved(arr) { try { fs.writeFileSync(APPROVED_FILE, JSON.stringify(arr, null, 2)); } catch (e) {} }
function listDemos() {
  const out = [];
  for (const dir of DEMO_DIRS) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.toLowerCase().endsWith('.dem')) continue;
        const st = fs.statSync(path.join(dir, f));
        out.push({ name: f, dir, size: st.size, mtime: st.mtimeMs });
      }
    } catch (e) {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
app.get('/api/demos', requireAuth, (req, res) => {
  const ap = new Set(readApproved());
  res.json({ ok: true, demos: listDemos().map(d => ({ ...d, approved: ap.has(d.name) })) });
});
// Toggle a demo's public-approved state
app.post('/api/demos/approve', requireAuth, (req, res) => {
  const name = String((req.body && req.body.file) || '').replace(/[^a-zA-Z0-9_.\-]/g, '');
  if (!name.toLowerCase().endsWith('.dem')) return res.status(400).json({ ok: false, error: 'bad file' });
  let ap = readApproved();
  if (ap.includes(name)) ap = ap.filter(x => x !== name); else ap.push(name);
  writeApproved(ap);
  res.json({ ok: true, approved: ap.includes(name) });
});
// Clean PUBLIC URL — only serves APPROVED demos: /videos/<name>.dem
app.get('/videos/:file', (req, res) => {
  const name = String(req.params.file || '').replace(/[^a-zA-Z0-9_.\-]/g, '');
  if (!name.toLowerCase().endsWith('.dem')) return res.status(400).end('bad file');
  if (!readApproved().includes(name)) return res.status(403).end('This demo is not public.');
  const hit = listDemos().find(d => d.name === name);
  if (!hit) return res.status(404).end('not found');
  res.download(path.join(hit.dir, name));
});
app.get('/api/demos/download', requireAuth, (req, res) => {
  const name = String(req.query.file || '').replace(/[^a-zA-Z0-9_.\-]/g, '');
  if (!name.toLowerCase().endsWith('.dem')) return res.status(400).end('bad file');
  const hit = listDemos().find(d => d.name === name);
  if (!hit) return res.status(404).end('not found');
  res.download(path.join(hit.dir, name));
});
app.post('/api/demos/delete', requireAuth, (req, res) => {
  const name = String((req.body && req.body.file) || '').replace(/[^a-zA-Z0-9_.\-]/g, '');
  if (!name.toLowerCase().endsWith('.dem')) return res.status(400).json({ ok: false, error: 'bad file' });
  const hit = listDemos().find(d => d.name === name);
  if (!hit) return res.status(404).json({ ok: false, error: 'not found' });
  try {
    fs.unlinkSync(path.join(hit.dir, name));
    writeApproved(readApproved().filter(x => x !== name));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
  let players = null, mapInfo = null, a2s = null, playerList = [];
  if (running) {
    try { a2s = await a2sInfo(); } catch (e) {}
    let statusTxt = '';
    try { statusTxt = await rconExec('status'); } catch (e) {}
    const c = parsePlayersServer(statusTxt); if (c) players = { humans: c.humans, bots: c.bots };
    const parsed = parseStatusPlayers(statusTxt); if (parsed) playerList = parsed.map(p => ({ name: p.name, bot: p.bot }));
    if (!players && a2s) players = { humans: Math.max(0, a2s.players - a2s.bots), bots: a2s.bots };
  }
  if (wsId) { try { mapInfo = await cachedWsInfo(wsId); } catch (e) {} }
  res.json({
    running,
    port: v.PORT || '27015',
    password: v.SV_PW || '',
    mapName: (a2s && a2s.map) || liveMap || v.MAP || '',
    isWorkshop: isWs,
    mapInfo, // {title, preview, url} or null
    game_type: v.GAME_TYPE, game_mode: v.GAME_MODE,
    players, playerList,
    demos: (() => { const all = listDemos(); return readApproved().map(n => { const f = all.find(d => d.name === n); return f ? { name: n, size: f.size } : null; }).filter(Boolean); })(),
  });
});

// Root = public read-only status page. Admin panel lives at /admin.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'status.html')));
app.get('/status', (req, res) => res.sendFile(path.join(__dirname, 'public', 'status.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.listen(PANEL_PORT, () => console.log(`CS2 panel listening on http://0.0.0.0:${PANEL_PORT}`));
