# Deploying the Kaotic Gaming site with Docker

This repo ships the same Kaotic Gaming site stack used by Solo Fighter / Last Stand, with
**Knife Thrower** as the game on the home page. It's a single container: a small Node.js
server (no npm packages) with a built-in SQLite database. Everything the site stores
(accounts, saves, stats, error reports, purchases) is in one Docker volume mounted at `/data`.

## Quick start

```bash
git clone https://github.com/TimLeitch/knife-fighter.git
cd knife-fighter
cp .env.example .env          # then edit .env (see below)
docker compose up -d --build
```

The site listens on port **8088** (change with `SITE_PORT` in `.env`).
Check it: `curl http://localhost:8088/healthz` → `{"ok":true}`.
Play: http://localhost:8088/play/knife-thrower

## Settings (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `SITE_PORT` | `8088` | Port on the server the site is published on. |
| `TRUST_PROXY` | `1` | `1` when a reverse proxy or Cloudflare Tunnel is in front: the site then reads the visitor's real IP (`CF-Connecting-IP` / `X-Forwarded-For`) for rate limits, and `X-Forwarded-Proto` to mark login cookies Secure. Set `0` if the container is exposed directly. |
| `KG_ADMIN_USER` / `KG_ADMIN_PASSWORD` | empty | Creates the first admin account on a start where no admin exists. Password: 8+ characters. Remove the password from `.env` afterwards. |
| `TUNNEL_TOKEN` | empty | Only for the optional Cloudflare Tunnel container. |
| `PAYPAL_ENV` | `sandbox` | `sandbox` (test money) or `live` (real money) for the 99¢ Supporter Pack. |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | empty | The PayPal app's keys for that mode. Empty = the shop is off. |
| `PAYPAL_WEBHOOK_ID` | empty | The ID of the webhook on that PayPal app. Required for live. |
| `PAYPAL_TESTERS` | empty | Usernames (comma separated) who may buy while in sandbox, besides admins. |

## The first admin account

Either set `KG_ADMIN_USER` / `KG_ADMIN_PASSWORD` before the first start, or run:

```bash
docker compose exec site node server.js create-admin <username>
```

It asks for the password (or reads `KG_ADMIN_PASSWORD`). The same command makes an existing
account an admin. The admin dashboard is at `/admin`.

(The `/setup` page only works for a browser on the same machine as the server, so in Docker use one of the two ways above.)

## Putting it on the web

**Option A: Cloudflare Tunnel (no open ports).**

1. Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel.
2. Copy the token from the install command into `TUNNEL_TOKEN` in `.env`.
3. Add a published application route: your hostname → `http://site:8088`.
4. `docker compose --profile tunnel up -d --build`

**Option B: a reverse proxy** (nginx, Traefik, Caddy) with HTTPS, forwarding to `localhost:8088`:

```nginx
location / {
    proxy_pass http://127.0.0.1:8088;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Taking payments (the 99¢ Supporter Pack)

Same PayPal flow as the Solo Fighter deploy. Full walkthrough (sandbox → live, micropayments,
refunds): see the **Taking payments** section in
[solo-fighter/DEPLOY.md](https://github.com/TimLeitch/solo-fighter/blob/main/DEPLOY.md)
if that repo is your reference, or follow PayPal's merchant docs with webhook URL
`https://YOUR_HOST/api/paypal/webhook`.

In this repo the pack unlocks a ♥ supporter badge on the high scores (no in-game outfit yet).

## Day-to-day

| Task | Command |
|---|---|
| Logs | `docker compose logs -f site` |
| Update to the latest code | `git pull && docker compose up -d --build` |
| Restart | `docker compose restart site` |
| Stop | `docker compose down` (data stays in the `kg-data` volume) |

## Backups

```bash
docker compose exec site node server.js backup /data/backup-$(date +%F).db
docker compose cp site:/data/backup-$(date +%F).db ./
```

Restore: stop the site, replace `kaotic.db` in the volume with the backup (and delete any
`kaotic.db-wal` / `kaotic.db-shm` next to it), start the site.

## Adding more games

Games are listed in `site/games.json`; each points at an HTML file inside the repo
(see `site/README.md` → "Adding another game"). Games use `site/public/sdk.js` to save to the
player's account and report progress to the admin page.

## What's in the container

- Image: `node:24-alpine`, runs as the unprivileged `node` user.
- App: `/app/site/server.js`; game: `/app/index.html` (+ anything under `site/games/`).
- Data: `/data/kaotic.db` (volume `kg-data`).
- Health check: `GET /healthz` every 30 s.
