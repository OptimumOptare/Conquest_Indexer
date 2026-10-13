/**
 * HTTP surface (UD21): `GET /snapshot`, `GET /events?since=<block>`, `GET /health`, plus the
 * UD24 indexes `GET /players`, `GET /presence` and `GET /policy?nation=<id>`, and the cached reads
 * `GET /positions` and `GET /leaderboard`.
 *
 * Read-only, no auth, no per-client state — a plain cacheable JSON API that a CDN can sit in
 * front of later. CORS is an explicit origin allowlist (UD22): this service is on its own
 * origin and answers only the site.
 *
 * Feed responses carry raw logs, never decoded events. The client decodes them with the same ABIs
 * it uses for its own RPC fallback, so this service cannot invent an event field or synthesize
 * a feed entry (AGENTS rule 12) — only withhold or replay real ones.
 *
 * The index routes say only *who to ask about*: addresses and (player, province) pairs. The
 * client still reads every number from the chain, so a wrong entry costs one read that returns 0.
 * What they must never do is look complete when they are not, so until ingest has reached the
 * tip and the indexes are built they answer 503 `{ catchingUp: true }` (UD24).
 *
 * `/policy` (U22.6) is a feed route in an index's envelope: one nation's whole-round policy logs,
 * raw, matched by the nation-id topics, with no cap and no chain read.
 *
 * `/positions` (U22.3) does serve numbers, but only return values of `effectiveTroops` read at
 * the `asOfBlock` it states, so a client can check any of them with the same `eth_call`
 * (UD24 rules 2–3). It answers 503 the same way until its first full read is done.
 * `/leaderboard` (U22.4) is the same kind of route over `SchizoLens.getPlayer`, with `troops`
 * summed from `/positions` at the same block.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Config } from './config.js';
import type { Store } from './db.js';
import type { Ingestor } from './ingest.js';

/** Rows one `/events` response may carry before it asks the client to come back. */
export const EVENTS_ROW_LIMIT = 2_000;

function corsHeaders(
  config: Config,
  origin: string | undefined,
): Record<string, string> {
  if (origin === undefined) return {};
  const normalized = origin.replace(/\/+$/, '');
  if (!config.allowedOrigins.includes(normalized)) return {};
  return {
    'access-control-allow-origin': normalized,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // Deltas are polled every ~2 s and the tip moves constantly — caching either is a lie.
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/**
 * `?province=` / `?nation=` → a uint16 id (the format both ids have on chain), `undefined` when
 * absent, `null` when malformed.
 */
function parseId(value: string | null): number | null | undefined {
  if (value === null) return undefined;
  if (!/^\d{1,5}$/.test(value)) return null;
  const id = Number(value);
  return id >= 1 && id <= 0xffff ? id : null;
}

/** `?player=` → a lowercased address, `undefined` when absent, `null` when malformed. */
function parsePlayer(value: string | null): string | null | undefined {
  if (value === null) return undefined;
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
}

function parseSince(value: string | null): bigint | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Body for an index route that cannot vouch for a complete answer yet. */
const CATCHING_UP = { catchingUp: true } as const;

/** `/health`'s view of the `/positions` cache. A sweep that changed values is a missing trigger. */
function positionsHealth(ingestor: Ingestor) {
  const status = ingestor.positions.status();
  return {
    ready: status.ready,
    roundId: status.roundId?.toString() ?? null,
    asOfBlock: status.asOfBlock?.toString() ?? null,
    entries: status.entries,
    dirtyProvinces: status.dirtyProvinces,
    lastError: status.lastError,
    lastSweep:
      status.lastSweep === null
        ? null
        : { ...status.lastSweep, block: status.lastSweep.block.toString() },
    sweepChangedTotal: status.sweepChangedTotal,
  };
}

/** `/health`'s view of the `/leaderboard` cache. A sweep that changed rows is a missing trigger. */
function leaderboardHealth(ingestor: Ingestor) {
  const status = ingestor.leaderboard.status();
  return {
    ready: status.ready,
    roundId: status.roundId?.toString() ?? null,
    asOfBlock: status.asOfBlock?.toString() ?? null,
    rows: status.rows,
    dirtyPlayers: status.dirtyPlayers,
    dirtyNations: status.dirtyNations,
    lastError: status.lastError,
    lastSweep:
      status.lastSweep === null
        ? null
        : { ...status.lastSweep, block: status.lastSweep.block.toString() },
    sweepChangedTotal: status.sweepChangedTotal,
  };
}

export function createHttpHandler(
  config: Config,
  store: Store,
  ingestor: Ingestor,
) {
  return function handle(req: IncomingMessage, res: ServerResponse): void {
    const headers = corsHeaders(config, req.headers.origin);
    const url = new URL(req.url ?? '/', 'http://indexer.local');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      send(res, 405, { error: 'method not allowed' }, headers);
      return;
    }

    try {
      switch (url.pathname) {
        case '/health': {
          const status = ingestor.status();
          // Unhealthy only if the loop never got going. A transient RPC error must not fail
          // the platform healthcheck — restarting the process does not fix someone else's RPC,
          // and a restart loop turns a degraded feed into no feed at all.
          const neverStarted =
            status.lastTickAt === null && status.lastError !== null;
          send(
            res,
            neverStarted ? 503 : 200,
            {
              chainId: config.chainId,
              headBlock: status.headBlock.toString(),
              chainTip: status.chainTip.toString(),
              lagBlocks: (status.chainTip > status.headBlock
                ? status.chainTip - status.headBlock
                : 0n
              ).toString(),
              catchingUp: status.catchingUp,
              backfillRequests: status.backfillRequests,
              events: store.eventCount(),
              lastTickAt: status.lastTickAt,
              lastError: status.lastError,
              positions: positionsHealth(ingestor),
              leaderboard: leaderboardHealth(ingestor),
            },
            headers,
          );
          return;
        }

        case '/snapshot': {
          send(
            res,
            200,
            {
              chainId: config.chainId,
              asOfBlock: store.headBlock().toString(),
              roundStartBlock: store.roundStartBlock(),
              logs: store.snapshotLogs(),
            },
            headers,
          );
          return;
        }

        case '/events': {
          const since = parseSince(url.searchParams.get('since'));
          if (since === null) {
            send(res, 400, { error: 'since must be a block number' }, headers);
            return;
          }
          const page = store.eventsSince(since, EVENTS_ROW_LIMIT);
          const reorgFrom = store.reorgFrom(since);
          send(
            res,
            200,
            {
              chainId: config.chainId,
              asOfBlock: page.asOfBlock.toString(),
              ...(reorgFrom !== null ? { reorgFrom: reorgFrom.toString() } : {}),
              logs: page.logs,
            },
            headers,
          );
          return;
        }

        case '/players':
        case '/presence': {
          if (ingestor.status().catchingUp || !store.indexesReady()) {
            send(res, 503, CATCHING_UP, headers);
            return;
          }
          const envelope = {
            chainId: config.chainId,
            roundId: store.currentRound().roundId.toString(),
            asOfBlock: store.headBlock().toString(),
          };
          send(
            res,
            200,
            url.pathname === '/players'
              ? { ...envelope, players: store.players() }
              : { ...envelope, presence: store.presence() },
            headers,
          );
          return;
        }

        case '/policy': {
          // Bounded by the uint16 id format, not `nationCountTotal`, which only an eth_call could
          // supply. An id past the last nation simply has no policy logs.
          const nation = parseId(url.searchParams.get('nation'));
          if (nation === null || nation === undefined) {
            send(res, 400, { error: 'nation must be a nation id' }, headers);
            return;
          }
          if (ingestor.status().catchingUp) {
            send(res, 503, CATCHING_UP, headers);
            return;
          }
          send(
            res,
            200,
            {
              chainId: config.chainId,
              roundId: store.currentRound().roundId.toString(),
              asOfBlock: store.headBlock().toString(),
              logs: store.policyLogs(nation),
            },
            headers,
          );
          return;
        }

        case '/positions': {
          const province = parseId(url.searchParams.get('province'));
          if (province === null) {
            send(res, 400, { error: 'province must be a province id' }, headers);
            return;
          }
          const player = parsePlayer(url.searchParams.get('player'));
          if (player === null) {
            send(res, 400, { error: 'player must be an address' }, headers);
            return;
          }
          const view =
            ingestor.status().catchingUp || !store.indexesReady()
              ? null
              : ingestor.positions.view({
                  ...(province !== undefined ? { province } : {}),
                  ...(player !== undefined ? { player } : {}),
                });
          if (view === null) {
            send(res, 503, CATCHING_UP, headers);
            return;
          }
          send(
            res,
            200,
            {
              chainId: config.chainId,
              roundId: view.roundId.toString(),
              asOfBlock: view.asOfBlock.toString(),
              positions: view.positions,
            },
            headers,
          );
          return;
        }

        case '/leaderboard': {
          const view =
            ingestor.status().catchingUp || !store.indexesReady()
              ? null
              : ingestor.leaderboard.view();
          if (view === null) {
            send(res, 503, CATCHING_UP, headers);
            return;
          }
          send(
            res,
            200,
            {
              chainId: config.chainId,
              roundId: view.roundId.toString(),
              asOfBlock: view.asOfBlock.toString(),
              rows: view.rows,
            },
            headers,
          );
          return;
        }

        default:
          send(res, 404, { error: 'not found' }, headers);
      }
    } catch (error) {
      send(
        res,
        500,
        { error: error instanceof Error ? error.message : 'internal error' },
        headers,
      );
    }
  };
}

export function startServer(config: Config, store: Store, ingestor: Ingestor) {
  const server = createServer(createHttpHandler(config, store, ingestor));
  server.listen(config.port, () => {
    process.stdout.write(
      `indexer listening on :${config.port} (chain ${config.chainId}, ` +
        `origins ${config.allowedOrigins.join(', ') || 'none'})\n`,
    );
  });
  return server;
}
