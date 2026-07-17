# CS2 Web Control Panel

A simple browser dashboard to manage a Counter-Strike 2 dedicated server:
start/stop/restart, change map & mode, edit passwords, toggle practice mode,
run RCON commands, and view live logs. Poki-style UI (Bootstrap 5 + Font Awesome).

## Requirements
- A working CS2 dedicated server installed at `/home/steam/cs2_server`
- A `cs2` systemd service that runs `start.sh` (see below)
- Node.js 18+ on the VPS

## Quick install (run as root on the VPS)

```bash
# 1. Install Node
apt update && apt install -y nodejs npm git

# 2. Clone this repo
git clone https://github.com/hamamed/cs2.git /opt/cs2-panel
cd /opt/cs2-panel
npm install

# 3. Put the server files in place
cp start.sh server-vars.conf /home/steam/cs2_server/
chmod +x /home/steam/cs2_server/start.sh
chown steam:steam /home/steam/cs2_server/start.sh /home/steam/cs2_server/server-vars.conf

# 4. Edit your real settings (GSLT token + passwords)
nano /home/steam/cs2_server/server-vars.conf
```

## Create the CS2 game-server service (`/etc/systemd/system/cs2.service`)

```ini
[Unit]
Description=CS2 Server
After=network.target
[Service]
Type=simple
User=steam
WorkingDirectory=/home/steam/cs2_server/game/bin/linuxsteamrt64
ExecStart=/home/steam/cs2_server/start.sh
Restart=on-failure
RestartSec=10
[Install]
WantedBy=multi-user.target
```
```bash
systemctl daemon-reload && systemctl enable --now cs2
```

## Create the panel service (`/etc/systemd/system/cs2-panel.service`)
Copy the included `cs2-panel.service`, edit `PANEL_PASS`, then:
```bash
cp /opt/cs2-panel/cs2-panel.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now cs2-panel
ufw allow 8080/tcp
```

Open `http://YOUR_SERVER_IP:8080` and log in.

## Updating the game server (no SSH)

The **Update Server** button in the Server Power card runs SteamCMD
(`app_update 730 validate`) for you: it stops the server, streams the download
progress live in a console popup, then restarts the server automatically.

SteamCMD is auto-detected in the usual locations (`~steam/steamcmd/steamcmd.sh`,
the apt `steamcmd` package at `/usr/games/steamcmd`, or anything on `PATH`), and
run as the `steam` user against `/home/steam/cs2_server`. The panel runs as root,
so it can `su - steam` without a password. If SteamCMD lives somewhere unusual
or the server dir differs, set `STEAMCMD` / `CS2_DIR` / `STEAM_USER` (or override
the whole `UPDATE_CMD`) in `cs2-panel.service`. If SteamCMD isn't installed, the
update console tells you so instead of failing silently.

**Reinstall** (next to Update) deletes Steam's game files and downloads a fresh
copy — use it when an update keeps failing with a `state 0x2xx` (corrupt/missing
files) error. It first moves your `addons/` (plugins), `cfg/` and `.dem` demos
aside, clears workshop downloads to free space, deletes the old ~63 GiB install,
downloads a clean copy, then restores your preserved files. `start.sh` and
`server-vars.conf` are never touched.

## Updating the panel itself later
```bash
cd /opt/cs2-panel && git pull && npm install && systemctl restart cs2-panel
```

> Note: `server-vars.conf` here holds placeholders only. Your real GSLT token
> and passwords live in `/home/steam/cs2_server/server-vars.conf` on the VPS and
> are never committed.
