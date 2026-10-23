# Kaotic Gaming site: accounts, saves, admin page, and the games listed in site/games.json.
# Plain Node.js (built-in SQLite), no npm packages. Player data lives in the /data volume.
FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8088 \
    KG_DATA_DIR=/data

WORKDIR /app
# Knife Thrower lives at the repo root; more games can live under site/games/
COPY index.html ./index.html
COPY site ./site

# run as the unprivileged "node" user; it must own the data folder
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/site

EXPOSE 8088
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8088) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
