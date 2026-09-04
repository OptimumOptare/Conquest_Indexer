/**
 * HTTP surface (UD21): `GET /snapshot`, `GET /events?since=<block>`, `GET /health`.
 *
 * Read-only, no auth, no per-client state — a plain cacheable JSON API that a CDN can sit in
 * front of later. CORS is an explicit origin allowlist (UD22): this service is on its own
 * origin and answers only the site.
 *
 * Responses carry raw logs, never decoded events. The client decodes them with the same ABIs
 * it uses for its own RPC fallback, so this service cannot invent an event field or synthesize
 * a feed entry (AGENTS rule 12) — only withhold or replay real ones.
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

function parseSince(value: string | null): bigint | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
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
