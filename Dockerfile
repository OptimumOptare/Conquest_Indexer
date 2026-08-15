# better-sqlite3 is a native module, so the image needs a toolchain at install time.
# Single stage on purpose: a two-stage build would have to rebuild the native module in the
# runtime stage anyway, and the size difference does not matter for one small service.
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=8787
# Railway mounts its volume here (see README) — the SQLite file must live on it.
ENV DB_PATH=/data/indexer.db
EXPOSE 8787

CMD ["node", "dist/main.js"]
