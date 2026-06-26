// CS2 Web Control Panel
// Runs on the VPS, controls the `cs2` systemd service and talks RCON to the server.
const express = require('express');
const session = require('express-session');
const { exec } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

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
  let info = '';
  if (running) {
    try { info = await rconExec('status'); } catch (e) { info = '(server up, RCON not ready: ' + e.message + ')'; }
  }
  res.json({ running, state: active.out.trim(), vars: readVars(), info });
});

// Start / stop / restart
app.post('/api/control', requireAuth, async (req, res) => {
  const action = (req.body && req.body.action) || '';
  if (!['start', 'stop', 'restart'].includes(action)) return res.status(400).json({ error: 'bad action' });
  const r = await sh(`systemctl ${action} ${SERVICE}`);
  res.json({ ok: r.ok, out: r.out || `${action} sent` });
});

// Raw RCON command
app.post('/api/rcon', requireAuth, async (req, res) => {
  const cmd = (req.body && req.body.cmd) || '';
  if (!cmd.trim()) return res.status(400).json({ error: 'empty command' });
  try { res.json({ ok: true, out: await rconExec(cmd) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
  if (body._restart) { const r = await sh(`systemctl restart ${SERVICE}`); out += r.ok ? ' Restarting…' : ' (restart failed: ' + r.out + ')'; }
  res.json({ ok: true, out });
});

// Recent server logs
app.get('/api/logs', requireAuth, async (req, res) => {
  const r = await sh(`journalctl -u ${SERVICE} -n 120 --no-pager`);
  res.json({ ok: true, out: r.out });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PANEL_PORT, () => console.log(`CS2 panel listening on http://0.0.0.0:${PANEL_PORT}`));
