# Snooker Online Web Game

A lightweight browser billiards game with canvas physics, multiple rule modes, and room-code multiplayer. It runs on a plain Node.js HTTP/WebSocket server without a frontend build step.

Live example: http://snooker.aoodyconcor.de

## Features

- Four game modes: 8-ball, 9-ball, snooker, and practice.
- Canvas-rendered table, balls, rails, pockets, cue, aiming guide, and target-ball guide.
- Tuned billiards feel: rolling friction, cushion rebounds, ball collisions, smaller competitive pockets, and speed-aware pocket behavior.
- Keyboard, mouse, and touch aiming.
- Room-code online play with native WebSocket synchronization.
- Host-authoritative physics for multiplayer rooms.
- Client-side interpolation/extrapolation smooths multiplayer ball motion between server snapshots.
- Compact icon-led game HUD using a local Lucide bundle.
- Built-in health endpoint at `/health`.
- Test hooks for automation: `window.render_game_to_text()` and `window.advanceTime(ms)`.

## Controls

- Drag or click on the table to aim and shoot.
- `Space`: shoot.
- Arrow keys: fine tune aim and power.
- Hold `Shift`: slower keyboard adjustment.
- `F`: toggle fullscreen.

## Local Development

Requirements:

- Node.js 18 or newer.

Run:

```bash
npm start
```

Open:

```text
http://localhost:5173
```

Use another port:

```bash
PORT=8080 npm start
```

## Project Structure

```text
.
├── public/
│   ├── index.html
│   ├── styles.css
│   ├── js/app.js
│   └── vendor/lucide.min.js
├── server.js
├── package.json
└── README.md
```

## Deployment

The app can be deployed behind Nginx, BaoTa/BT Panel, or any reverse proxy that supports WebSocket upgrades.

### 1. Upload Files

Copy the project to your server, for example:

```bash
mkdir -p /www/wwwroot/snooker.example.com
tar -xzf snooker-online-web-game.tar.gz -C /www/wwwroot/snooker.example.com
cd /www/wwwroot/snooker.example.com
```

### 2. Run With systemd

Create `/etc/systemd/system/snooker-game.service`:

```ini
[Unit]
Description=Snooker online web game
After=network.target

[Service]
Type=simple
WorkingDirectory=/www/wwwroot/snooker.example.com
Environment=NODE_ENV=production
Environment=PORT=5173
ExecStart=/usr/bin/node /www/wwwroot/snooker.example.com/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
systemctl daemon-reload
systemctl enable --now snooker-game.service
systemctl status snooker-game.service
```

If your Node binary is somewhere else, update `ExecStart`.

### 3. Nginx Reverse Proxy

Create a site config like:

```nginx
server {
    listen 80;
    server_name snooker.example.com;
    root /www/wwwroot/snooker.example.com/public;
    index index.html;

    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
```

Reload:

```bash
nginx -t
systemctl reload nginx
```

### 4. BaoTa/BT Panel Notes

For BaoTa, add the site in the normal Website list, then set the Nginx config to proxy `http://127.0.0.1:5173`. Make sure the site record points at the app directory, for example:

```text
/www/wwwroot/snooker.example.com
```

The current production setup uses:

```text
/www/wwwroot/snooker.aoodyconcor.de
```

### 5. DNS And HTTPS

Point your domain `A` record to the server IP. After DNS resolves, use BaoTa or Certbot to issue HTTPS. WebSocket automatically switches to `wss://` when the page is loaded over HTTPS.

## Verification

Useful checks:

```bash
curl http://127.0.0.1:5173/health
curl http://snooker.example.com/health
```

Expected:

```json
{"ok":true,"rooms":0,"clients":0}
```

WebSocket upgrade should return `101 Switching Protocols`.

## Release

`v1.0.0` is the first public release. It includes the full game, online rooms, the icon-led HUD, smaller competitive pockets, and deployment docs.
