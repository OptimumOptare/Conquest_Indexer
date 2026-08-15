# schizo-indexer

History indexer for **Schizo Conquest** (ticket U12.4, decisions UD21/UD22).

It ingests the §16 event catalog from the six game contracts once, server-side, and serves it
over HTTP so browsers never crawl the chain for history:

| Route | Purpose |
|---|---|
| `GET /snapshot` | Current feed history (per-category rings, current round only) + `asOfBlock` |
| `GET /events?since=<block>` | Deltas above `<block>`, polled on the client's ~2 s cadence |
| `GET /health` | `headBlock`, `chainTip`, `lagBlocks`, `catchingUp`, `lastError` |

## The boundary this service sits on

**History here; gameplay state on-chain.** Provinces, nations, params and player state come from
`SchizoLens` over RPC and never from this service, so a stale — or hostile — indexer cannot
change what a battle does. Feeds, leaderboards and other append-only history are the only things
that live here, and if this service disappears the frontend degrades to its own log tail with
the game fully playable.

Two properties keep that honest:

- **The wire format is raw logs, not decoded events.** `address / topics / data / blockNumber /
  blockHash / transactionHash / logIndex`, exactly as the RPC returned them. The client decodes
  with the same committed ABIs it uses for its fallback path. This service therefore cannot
  invent an event field or synthesize a feed entry — only withhold or replay real logs.
- **No game numbers.** Costs, rates and cooldowns are read by the client from the on-chain param
  registry. Nothing here knows or serves a game parameter.

## Run it locally

```bash
cp .env.example .env      # set RPC_HTTP at minimum
npm install
npm run dev
```

Against a live chain, set `START_BLOCK` near the tip for a quick local run — the default is the
AdminController deploy block, which is a full history crawl. Point the frontend at it by editing
`ui/public/config.json` in the game repo:

```json
{ "indexerUrl": "http://localhost:8787" }
```

`ALLOWED_ORIGINS` must contain the site origin exactly (`http://localhost:5173` for Vite dev).
Plain `http:` is accepted by the client only on loopback; in production the URL must be `https:`
or the browser blocks it as mixed content.

## Deploy on Railway

1. Push this repo to GitHub, then **New Project → Deploy from GitHub repo**. `railway.json`
   selects the Dockerfile build and the `/health` healthcheck; nothing else to configure.
2. **Add a Volume** mounted at `/data`. Without it the SQLite file lives in the container
   filesystem and every deploy re-crawls the chain from `START_BLOCK`.
3. Set variables: `RPC_HTTP` (give the indexer its **own** key — a blown quota must not take the
   game's RPC down with it), `ALLOWED_ORIGINS` (the site origin, no trailing slash), `CHAIN_ID`,
   `START_BLOCK`, and `DB_PATH=/data/indexer.db` (already the Dockerfile default).
4. **Settings → Networking → Custom Domain**: add `indexer.<yourdomain>` and the CNAME Railway
   gives you. TLS is automatic. UD22 requires a stable custom domain from day one — the runtime
   config exists so the domain can move, not so it can be temporary.
5. **Do not enable app sleeping.** A sleeping service stops ingesting and wakes up behind.
6. Put the public URL in the frontend's `ui/public/config.json` on the static host.

Cost: one ~512 MB service plus a small volume, comfortably inside Railway's $5/mo Hobby credit.
The image is a plain Dockerfile, so the same build runs on Fly.io or any VPS if you outgrow it.

### RPC budget

Monad's ~0.4 s blocks are ~216k blocks/day. At `POLL_INTERVAL_MS=1000` this service issues
~86k `eth_getLogs` + `eth_getBlockNumber` pairs a day; at 2 s, half that. That is a second
consumer alongside every browser, so check it against your provider's quota before alpha and
give it a separate key.

## Keeping in sync with the game repo

`src/abis/*.json` and the §16 catalog in `src/catalog.ts` are **copies** of the game repo's
committed ABIs and `ui/src/chain/feedEvents.ts`. That is a drift risk, so it is checked, not
trusted:

```bash
GAME_REPO=/path/to/Conquestv2 npm run sync:abis        # copy ABIs, report catalog differences
GAME_REPO=/path/to/Conquestv2 npm run sync:abis:check  # fail instead of writing (CI)
```

Run it after any redeploy or data-model change. **After a redeploy also update `START_BLOCK` and
the contract addresses** (`ADDR_*` env vars, or the defaults in `src/config.ts`) and wipe the
volume — otherwise this serves a dead stack's history.

## Layout

```
src/config.ts   env → typed config; T58 address book defaults
src/catalog.ts  §16 categories + UD11 ring limits (copy of the UI's, checked by sync:abis)
src/db.ts       SQLite: events, cursor, reorg log; snapshot/delta queries
src/ingest.ts   eth_getLogs loop, ≤1,000-block ranges, parent-hash reorg rewind
src/server.ts   node:http routes + CORS allowlist
src/main.ts     wiring + graceful shutdown
```
