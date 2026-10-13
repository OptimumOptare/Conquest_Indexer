# schizo-indexer

History indexer for **Schizo Conquest** (tickets U12.4, U22.x; decisions UD21/UD22/UD24).

It ingests the §16 event catalog from `SchizoCore` once, server-side, and serves it
over HTTP so browsers never crawl the chain for history:

| Route | Purpose |
|---|---|
| `GET /snapshot` | Current feed history (per-category rings, current round only) + `asOfBlock` |
| `GET /events?since=<block>` | Deltas above `<block>`, polled on the client's ~2 s cadence |
| `GET /health` | `headBlock`, `chainTip`, `lagBlocks`, `catchingUp`, `lastError`, and the `/positions` and `/leaderboard` caches' state |
| `GET /players` | Every address with a `PlayerRegistered` log, **all rounds**, ascending (U22.1) |
| `GET /presence` | Every (player, province) pair of the current round, `{ [player]: number[] }` (U22.1) |
| `GET /positions` | `effectiveTroops` of every current-round pair at `asOfBlock`, `{ [province]: { [player]: troops } }`, nonzero only (U22.3) |
| `GET /positions?province=<id>` / `?player=<addr>` | One slice of the same shape. Both together intersect |
| `GET /leaderboard` | One row per `/players` address at `asOfBlock`: `nickname`, `conquestPoints`, `gold`, `shares`, `troops`, ascending by address. Sorting and paging are the client's (U22.4) |
| `GET /policy?nation=<id>` | Every current-round `policy` log that names nation `<id>`, oldest first, uncapped. Raw logs, same `logs` shape as `/snapshot` (U22.6) |

The UD24 routes share one wire contract: JSON, bigints as decimal strings, addresses
lowercased, and every body carries `chainId`, `roundId` and `asOfBlock`. Until ingest has reached
the tip and the indexes are built they answer **503 `{ catchingUp: true }`**, never a partial
body that looks complete. `/positions` and `/leaderboard` also answer 503 until their first full
read is done, and again after a reorg rewind until they have re-read everything. A malformed `province` or `player`
is a `400`, and so is a missing or malformed `nation`. `/snapshot` and `/events` are unchanged by them.

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

The index routes (UD24) serve no numbers either, only *who to ask about*. `/players` and
`/presence` are folds over this service's own `events` table, with the client still reading
every value on chain. `/presence` uses the same rules as the UI's `chain/troopPresence.ts`. The
pairs are a **superset** of the real garrisons, so a stale pair reads 0 and is harmless. The one
pair no troop event proves is the necromancy credit (Q-U19): for a `NecromancyResolved` that
revived troops, the service reads `SchizoLens.getNations` **at that log's block** and adds
(leader, capital). Both tables are written in the same transaction as the events, rewound with
them on a reorg, and rebuilt from `events` on boot if they predate the data. That rebuild never
re-crawls the chain.

### `/policy?nation=`: one nation's whole-round diplomacy history (U22.6)

The chain has no views for war expiry, alliance expiry, the last war or mode change, or pending
proposals, so the UI rebuilds all of them from policy events. `/snapshot` keeps only the newest
200 of those, so once a round passes 200 policy events the oldest wars, alliances and proposals
drop out of everything built from it. `/policy` serves one nation's whole round instead: every
`policy` log since `roundStartBlock()` that names the nation, oldest first, with no cap.

It is a feed route in an index's envelope. Logs are **raw**, exactly as `/snapshot` serves them,
and the client decodes them, so the route can withhold a log but never invent one (UD21).
**Matching is by topic, with no decoding.** Every policy event indexes the nations it is about:
`WarDeclared` (`byNation`, `onNation`), `AllianceProposed` (`byNation`, `toNation`),
`AllianceFormed` (`a`, `b`), and `nationId` on `NationRenamed`, `ModeChanged`, `LeaderChanged`,
`SharesDelegated` and `SharesUndelegated`. A `policy_nations(block_num, log_index, nation_id)` table
holds them. It is written in the same transaction as `commit()`, rewound with the events, and
backfilled from `events` on boot. That backfill needs no chain read, so it runs when the store
opens. The boot refuses to start if a `policy` event in the §16 catalog has no entry in that
table, or if the ABI stops indexing a listed arg as a `uint16`. Either would silently drop that
event from the route.

**No `eth_call`.** `nation` is checked against the `uint16` id format, not
`nationCountTotal`, which only a chain read could supply. Missing, malformed, `0` or above
`65535` is a `400`. An id past the last nation answers `200` with an empty `logs`.

### `/positions`: cached `effectiveTroops` (U22.3)

`/positions` does serve numbers, but **no troop math lives here** (UD24 rule 1). Every value is
the return of `SchizoCore.effectiveTroops(province, player)`, read in Multicall3 `aggregate3`
batches with `eth_call` at a stated block, over the `/presence` pairs. Anyone can re-run that
call at `asOfBlock` and compare, which is what the client's spot-check does (UD24 rule 3).

It refreshes on change, not on a timer. The view reads `units`, `troopFactorRaw` and
`factorEpoch`, and the contract writes those only in transactions that log the province they
touched. After each ingest batch at the tip, these provinces are dirty, and every pair in them is
re-read at the block ingest reached:

| Log | Dirty provinces |
|---|---|
| `TroopsRecruited`, `TroopsBurned`, `ProvinceConquered`, `ProvinceDestroyed`, `ProvinceRevived`, `InfectionSpread` | the province |
| `TroopsMoved`, `AttackResolved` | both ends |
| `WeaponDeployed` | `target` **and its neighbours** (a nuke cuts adjacents). Adjacency comes from `neighborsOf`, read once per target and kept, since `setEdges` only runs in round 1's Setup |
| `NecromancyResolved` that credited troops | that nation's capital (the same lens read as `/presence`) |
| `TickAdvanced` with `folded > 0` | every province with an `InfectionSpread` this round. The event carries a count, not a list |
| `RoundReset` | everything dropped; the new round is rebuilt from its own pairs |
| a reorg rewind | everything; nothing is served until the re-read at the new head |

No other province has been written since it was last read, so the whole cache holds at the new
head, and that block is `asOfBlock`. A block with no trigger advances `asOfBlock` without a read.
A failed read keeps serving the previous snapshot at **its own** block and retries the dirty set
on the next tick. Its error shows on `/health` under `positions.lastError`, and ingest carries
on regardless.

That argument is only as good as the trigger table, so it is checked. **Every
`POSITIONS_SWEEP_MS` (5 min) the cache re-reads every pair**, counts the values that moved in
provinces no trigger touched, and logs `positions sweep at block N: P pairs re-read, C changed
with no trigger`. A nonzero `C` means a trigger is missing. It is logged as a warning with the
first few (province, player, cached, chain) values, and summed on `/health` as
`positions.sweepChangedTotal`. The sweep's values replace the cache either way, so a missed
trigger never strands a value for longer than one interval. The boot also refuses to start if an
ABI sync renamed a trigger's arg or the catalog dropped a trigger event.

Known gap: `/presence` cannot name the nuke remnant owner (`0x…dEaD`, D38), which `applyNuke`
credits with no troop event. That one troop is missing here, and from the UI's garrison list for
the same reason.

### `/leaderboard`: cached player metrics (U22.4)

One row per `/players` address. `nickname`, `conquestPoints` and `gold` are fields of
`SchizoLens.getPlayer(player, 1..nationCountTotal)` read at `asOfBlock`, and `shares` is the sum
of its `holdings[].shares`. `troops` is the sum of that player's `/positions` entries. Rows are
published only when `/positions` holds the same block, so every field of every row holds at
`asOfBlock`, and a client can re-run any of them there. CP and the nickname live in the registry
and survive a `RoundReset`; gold, shares and troops are round-scoped and read 0 after one. The row
itself stays, because `/players` spans every round.

**A player is re-read when an ingested log has their address in an address-typed arg.** The arg
list comes from the ABI, not from a list of events. That rule was checked against every contract
writer of the four fields, and it misses one class: leader actions. `setMode`, `rename`,
`proposeAlliance` and `declareWar` charge the leader's gold, and deploying Bio, Orbital, Nuke or
Necromancy grants the leader CP, but `ModeChanged`, `NationRenamed`, `AllianceProposed`,
`WarDeclared` and `WeaponDeployed` carry nation ids only. Leader actions are never delegable, so
the payer is the nation's leader. Each of those logs also dirties `leaderOf(nation)` at the
refresh head. That is the payer unless leadership moved in between, and the only writer of the
leader, `claimLeadership`, logs `LeaderChanged(oldLeader, newLeader)`, which dirties both in the
same refresh. `RoundReset` dirties everyone.

| Writer | Fields | Log that names the player |
|---|---|---|
| `buyGold`, `harvest`, `claimFaucet` | gold, CP | `GoldPurchased` / `GoldHarvested` / `FaucetClaimed` `.player` |
| `recruit` | gold, shares | `TroopsRecruited.player` |
| `burn` refund | gold | `TroopsBurned.player` |
| `attack` kill CP | CP | `AttackResolved.attacker` |
| admin airdrops | gold, CP | `GoldAirdropped` / `CPAirdropped` `.player` |
| `setNickname`, `adminSetNickname` | nickname | `NicknameSet.player` |
| leader actions above | gold, CP | none; `leaderOf(nation)` at the head |

Everything else works the same way as `/positions`. A block that names no player advances
`asOfBlock` with no read, and `troops` follows `/positions`. A failed read, or `/positions` not yet
at the head, keeps serving the previous table at **its own** block and retries. Every
`LEADERBOARD_SWEEP_MS` (5 min) every player is re-read and `leaderboard sweep at block N: P
players re-read, C changed with no trigger` is logged. A nonzero `C` is a missing trigger, with
the changed fields of the first few rows, counted on `/health` as
`leaderboard.sweepChangedTotal`. The boot refuses to start if an ABI sync or catalog edit would
silence a writer's event, a player arg or a leader action's nation arg.

## Run it locally

```bash
cp .env.example .env      # set RPC_HTTP at minimum
npm install
npm run dev
```

On HyperRPC the default `START_BLOCK` (the `SchizoCore` deploy block) backfills the whole
chain in seconds, so leave it alone. On a range-capped RPC, set it near the tip for a quick
local run. Point the frontend at it by editing
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
3. Set variables: `RPC_HTTP` (steady state — the public Monad endpoint is fine; give the indexer
   its **own** key if you use a keyed one), `BACKFILL_RPC_HTTP` (HyperRPC — see below),
   `ALLOWED_ORIGINS` (the site origin, no trailing slash), `CHAIN_ID`, `START_BLOCK`, and
   `DB_PATH=/data/indexer.db` (already the Dockerfile default).
4. **Settings → Networking → Custom Domain**: add `indexer.<yourdomain>` and the CNAME Railway
   gives you. TLS is automatic. UD22 requires a stable custom domain from day one — the runtime
   config exists so the domain can move, not so it can be temporary.
5. **Do not enable app sleeping.** A sleeping service stops ingesting and wakes up behind.
6. Put the public URL in the frontend's `ui/public/config.json` on the static host.

Cost: one ~512 MB service plus a small volume, comfortably inside Railway's $5/mo Hobby credit.
The image is a plain Dockerfile, so the same build runs on Fly.io or any VPS if you outgrow it.

### RPC choice and budget

**Two endpoints, split by job** — `RPC_HTTP` for the steady state, `BACKFILL_RPC_HTTP` for the
cold start. They have opposite requirements:

| | Job | Needs | Gets called |
|---|---|---|---|
| `RPC_HTTP` | tail: block number, block hash, ~3-block `getLogs` | a rate allowance (~2-4 req/s) | constantly |
| `BACKFILL_RPC_HTTP` | close a gap wider than `LOG_RANGE_MAX_BLOCKS` | a huge `getLogs` range | cold start, long outage |

That split is what makes a rate-limited endpoint usable. **HyperRPC advertises 5 requests/minute
on the free tier**, which would be hopeless for a 1 s poll — but a full deploy → tip backfill
costs 1–3 requests there and steady state costs **zero**. Verified: after backfilling 1,996,341
blocks, `backfillRequests` stayed frozen while the tail ingested 154 blocks over 45 s. (Measured
99 req/min sustained against HyperRPC without throttling, so the documented limit does not appear
to be enforced today — the split means it does not matter either way.)

`/health` reports `backfillRequests` so you can confirm this in production.

The tail's range needs are trivial, so no provider's range cap matters on `RPC_HTTP` — the public
Monad endpoint's 100-block cap is 30× what a tick asks for. Caps only ever hurt the backfill:

| Endpoint | `eth_getLogs` range cap | Deploy → tip backfill (1,996,341 blocks) |
|---|---|---|
| **HyperRPC** | none observed (1M tested) | **1 request, 271 logs, 0.2 MB, 0.22 s** |
| public `testnet-rpc.monad.xyz` | 100 blocks | ~17,300 requests |
| Alchemy free tier | 10 blocks | ~200,000 requests |

Verified end to end: with `BACKFILL_RPC_HTTP` set to HyperRPC and `RPC_HTTP` on the public Monad
endpoint, this service backfills from the deploy block to the chain tip (`lagBlocks: 0`, 271
events) in seconds, then tails on the public endpoint alone.

HyperRPC does **not** implement `eth_call` (`-32601`), which is why the game frontend cannot
switch to it wholesale — every lens read is an `eth_call`. Here only `RPC_HTTP` needs it, for the
necromancy lens read (one call per block that resolved a window), `/positions` and `/leaderboard`. The
necromancy read is historical, at the log's block. The public Monad endpoint serves historical
state back to the `SchizoCore` deploy block (checked 2026-10-10), so a cold start can resolve old
windows too.

`/positions` adds `ceil(dirty pairs / POSITIONS_BATCH_CALLS)` `eth_call`s per tick that moved
troops, none on a quiet tick, plus one full sweep of `ceil(all pairs / POSITIONS_BATCH_CALLS)`
every 5 min, `CATCHUP_CONCURRENCY` at a time. Every Monad RPC caps `eth_call` gas, and the public
endpoint's 30M is the lowest measured (Q-U35b). One `effectiveTroops` costs ~29k gas inside
`aggregate3` (measured there 2026-10-11: 200 calls 5.8M, 1,000 calls 29.0M), so
`POSITIONS_BATCH_CALLS=200`, the UI's on-demand chunk size, leaves ~5× margin. A sweep runs
inside the ingest loop, so a very large pair set delays the tail by the sweep's duration.
**This is the main reason to give the indexer its own `RPC_HTTP` key**: a sweep must never spend
the game's quota.

`/leaderboard` is the heavier of the two per call. **One `getPlayer` over all 194 nations costs
~11.2M gas**, and each extra one in the same `aggregate3` ~8.1M more (measured on the public
endpoint 2026-10-11; most of it is `pendingGold` per nation, which the row does not use). So
`LEADERBOARD_BATCH_CALLS=2` (~19.5M) under `LEADERBOARD_CALL_GAS=30000000`. Three fit with ~8%
margin, four do not. The explicit gas limit is required. With none, the public endpoint's default
ran a one- or two-call `aggregate3` of `getPlayer` out of gas, while three or more passed. A batch
of `getPlayer` therefore goes out as a raw `eth_call` with `gas` set, since viem's `multicall`
cannot pass one, and `allowFailure: false` makes any failed sub-call fail the read. Cost: one
`nationCountTotal` + `leaderOf` call and `ceil(dirty players / 2)` `getPlayer` calls per tick that
named a player, none on a quiet tick, and `ceil(players / 2)` per sweep. The UI's per-field reads
(`nicknameOf`, `conquestPoints`, `goldOf`, `sharesOf` × 194) give the same four values for ~2.4M
gas per player, if that ever matters more than one call per player.

Steady state: Monad testnet produces ~3.35 blocks/s (measured), ~289k blocks/day. At
`POLL_INTERVAL_MS=1000` this service issues ~86k `eth_getLogs` + `eth_blockNumber` pairs a day,
each covering ~3 blocks; at 2 s, half that. Give it its own key either way, so a blown quota
cannot take the game's RPC down with it.

## Keeping in sync with the game repo

`src/abis/*.json` and the §16 catalog in `src/catalog.ts` are **copies** of the game repo's
committed ABIs and `ui/src/chain/feedEvents.ts`. That is a drift risk, so it is checked, not
trusted:

```bash
GAME_REPO=/path/to/Conquestv2 npm run sync:abis        # copy ABIs, report catalog differences
GAME_REPO=/path/to/Conquestv2 npm run sync:abis:check  # fail instead of writing (CI)
```

Run it after any redeploy or data-model change. **After a redeploy also update `START_BLOCK` and
the contract addresses** (`ADDR_CORE` / `ADDR_LENS`, or the defaults in `src/config.ts`) and wipe the
volume — otherwise this serves a dead stack's history.

## Layout

```
src/config.ts   env → typed config; M23 address book defaults (SchizoCore + SchizoLens)
src/catalog.ts  §16 categories + UD11 ring limits (copy of the UI's, checked by sync:abis)
src/db.ts       SQLite: events, cursor, reorg log, players/presence/policy_nations; snapshot/delta/index queries
src/indexes.ts  UD24 index facts per log: registrations, presence pairs (troopPresence.ts port)
src/policy.ts   /policy nation-id topics per policy event, checked against the catalog and ABI at boot
src/positions.ts /positions cache: trigger table, dirty re-reads at the head, safety sweep
src/leaderboard.ts /leaderboard cache: address-arg + leader triggers, getPlayer at the head, sweep
src/ingest.ts   eth_getLogs loop, parent-hash reorg rewind, necromancy lens read, index backfill
src/server.ts   node:http routes + CORS allowlist
src/main.ts     wiring + graceful shutdown
```
