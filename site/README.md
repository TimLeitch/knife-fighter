# Kaotic Gaming site

The Kaotic Gaming website: player accounts, a game list, per-game saves, high scores, the 99¢
Supporter Pack shop, and an admin page that shows who is playing what and how each player is
doing in each game. In this repo the featured game is **Knife Thrower**.

## What's in this folder

| File | What it does |
|---|---|
| `server.js` | The whole site server. Needs Node.js 22.13 or newer; no other installs. |
| `games.json` | The list of games on the site. |
| `public/` | Site pages: home, sign in, admin, high scores, the shop, first-time setup, and `sdk.js` (the game plug-in). |
| `start.cmd` | Double-click to start the site on Windows. |

## Running a copy on this PC (for testing)

1. Double-click `start.cmd`. Leave its window open: closing it stops the site.
2. First time only: open <http://localhost:8088/setup> on this computer and create your admin account.
3. The site is at <http://localhost:8088>. Knife Thrower is at <http://localhost:8088/play/knife-thrower>.
4. The admin page is at <http://localhost:8088/admin>.

This local copy's data (accounts, saves, stats) is **not** in this folder: it lives in
`%LOCALAPPDATA%\KaoticGaming\kaotic.db`, outside OneDrive, because OneDrive syncing a live database
can corrupt it.

Docker deploy, domain, backups and payments: [`../DEPLOY.md`](../DEPLOY.md).

## Adding another game

1. Put the game's HTML file somewhere under this project (for example `games/my-game/index.html`).
2. Add an entry to `games.json`:

   ```json
   {
     "slug": "my-game",
     "title": "My Game",
     "tagline": "One line about it",
     "description": "A sentence or two for the game card.",
     "entry": "games/my-game/index.html",
     "assets": "games/my-game",
     "color": "#3fa9f5",
     "status": "live"
   }
   ```

   - `slug`: lowercase letters, numbers and dashes; it becomes the address `/play/my-game`.
   - `entry`: the game's page, relative to this folder.
   - `assets` (optional): a folder of extra files the game loads with relative paths.
   - `status`: `live`, `beta` (shows a Beta tag) or `hidden` (not listed, can't be played).

   The site picks up changes to `games.json` within a few seconds; no restart needed.
3. In the game, use `window.KG` when it exists (see the top of `public/sdk.js`):
   `KG.save(data)` / `KG.initialSave` for saves, `KG.report({...})` for the numbers the admin
   page shows, `KG.event(type, data)` for moments like a run finished, and `KG.setStatus(text)`
   for the "Playing now" line. Errors are reported automatically.
