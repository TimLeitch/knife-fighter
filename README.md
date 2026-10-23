# Knife Thrower

A first-person knife-throwing game, plus the Kaotic Gaming website that hosts it.

| Path | What it is |
|---|---|
| `index.html` | **Knife Thrower**: the whole game in one file. Open it in a browser to play on its own (best scores saved in that browser). |
| `site/` | The **Kaotic Gaming** site: accounts, game list, per-game saves, high scores, the shop and an admin page. See [`site/README.md`](site/README.md). |

## Knife Thrower in short

- **Knife Wave** — rushers charge you; throw them down before they arrive. Deflect knives lobbed at you.
- **Target Range** — 60 seconds, unlimited knives: boards, balloons, bottles, gold. Farther throws score more.
- **Throwdown** — one-on-one vs ace throwers. Deflect, return fire, finish with a headshot.
- Hold click to charge a power throw. Right-click / Space knocks nearby enemy knives back.
- On the Kaotic site it saves best scores to the player's account and reports progress to the admin page.

## Host it with Docker

```bash
cp .env.example .env    # set the admin account etc.
docker compose up -d --build
```

Full instructions for the server, domain, backups and updates: **[DEPLOY.md](DEPLOY.md)**.

## Run the site locally

Needs Node.js 22.13+.

```bash
cd site
node server.js
```

Then open http://localhost:8088 (first time: http://localhost:8088/setup to create the admin account).
Play the game at http://localhost:8088/play/knife-thrower.
