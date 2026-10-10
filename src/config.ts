/**
 * Service configuration. Everything is an env var with a sane default except `RPC_HTTP`,
 * which has none on purpose: an indexer pointed at the wrong chain is worse than one that
 * refuses to boot.
 *
 * The contract addresses default to the M23 Monad-testnet deployment recorded in the UI's
 * address book (`ui/src/chain/addresses.ts` §00.6). They are deployment configuration, not
 * game parameters — no game number is ever hardcoded here or served from here.
 */

import { readFileSync } from 'node:fs';

/**
 * Load `.env` for local runs. Real environments (Railway) inject variables directly and have
 * no `.env`, so this is a no-op there — and it never overrides something already set.
 */
function loadDotEnv(path = '.env'): void {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const [, key, rawValue] = match;
    if (key === undefined || process.env[key] !== undefined) continue;
    process.env[key] = (rawValue ?? '').trim().replace(/^["']|["']$/g, '');
  }
}

/**
 * M21 / D32 — the six game contracts merged into one `SchizoCore`, which emits the whole §16
 * catalogue (M19a), so it is the only address this service ingests logs from. `lens` is
 * `SchizoLens`: read-only code, never a log source, called only where a route needs a value the
 * logs do not carry.
 */
export type ContractName = 'core' | 'lens';

export const CONTRACT_NAMES: readonly ContractName[] = ['core', 'lens'];

/** M23 monolith stack (alpha), Monad testnet (10143). Mirrors the UI address book. */
const MONAD_TESTNET_CONTRACTS: Record<ContractName, string> = {
  core: '0x37e46aB1b63CDCBc18a7C738Cc43e0c146C6873f',
  lens: '0x63449a654091e81c93DA574e29ddcFCc4E6FF65E',
};

/** SchizoCore creation block — the deploy anchor the browser must never crawl from. */
const MONAD_TESTNET_START_BLOCK = 63_589_123;

export type Config = {
  readonly chainId: number;
  /**
   * Steady-state RPC. Every `eth_blockNumber` / `eth_getBlockByNumber` and every tail
   * `eth_getLogs` goes here. The tail asks for ~3-block ranges, so **no provider's range cap
   * matters on this endpoint** — the caps only ever hurt a backfill.
   */
  readonly rpcHttp: string;
  /**
   * Optional wide-range RPC used **only** for `eth_getLogs` when the gap is bigger than one
   * `logRangeMaxBlocks` request — i.e. a cold start or a long outage. This is what makes a
   * rate-limited endpoint like HyperRPC's free tier (5 req/min) usable: a full deploy → tip
   * backfill spends exactly one request here, and steady state spends none.
   */
  readonly backfillRpcHttp: string | null;
  /** Range cap on the backfill endpoint. HyperRPC has none, so go wide. */
  readonly backfillLogRangeMaxBlocks: number;
  readonly contracts: Record<ContractName, `0x${string}`>;
  readonly startBlock: bigint;
  readonly port: number;
  readonly dbPath: string;
  /** Exact origins allowed to read this service (UD22). Empty ⇒ no CORS header at all. */
  readonly allowedOrigins: readonly string[];
  readonly pollIntervalMs: number;
  /**
   * Provider cap on one `eth_getLogs` span on `rpcHttp`. **Measured 100** on
   * `testnet-rpc.monad.xyz` and **10** on Alchemy's free tier (2026-08-15); Q-U36 recorded
   * 1,000 when it was measured, so the public endpoint has tightened since. Either is far more
   * than a tail tick needs (~3 blocks) — it only decides when the backfill endpoint takes over.
   */
  readonly logRangeMaxBlocks: number;
  /** Parallel range requests during the initial catch-up. */
  readonly catchupConcurrency: number;
  /** Blocks kept below the tip for reorg rewinds. */
  readonly reorgDepthBlocks: number;
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function intEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return Math.floor(parsed);
}

function addressEnv(name: ContractName, fallback: string): `0x${string}` {
  const key = `ADDR_${name.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
  const raw = env(key) ?? fallback;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`${key} is not an address: ${raw}`);
  }
  return raw as `0x${string}`;
}

export function loadConfig(): Config {
  loadDotEnv();
  const rpcHttp = env('RPC_HTTP');
  if (rpcHttp === undefined) {
    throw new Error('RPC_HTTP is required (the chain this indexer reads).');
  }

  const contracts = Object.fromEntries(
    CONTRACT_NAMES.map((name) => [
      name,
      addressEnv(name, MONAD_TESTNET_CONTRACTS[name]),
    ]),
  ) as Record<ContractName, `0x${string}`>;

  return {
    chainId: intEnv('CHAIN_ID', 10_143),
    rpcHttp,
    backfillRpcHttp: env('BACKFILL_RPC_HTTP') ?? null,
    // Wide enough that a cold start closes the whole deploy → tip gap in a single request.
    // A 1M window needed three (the gap is ~2M and each tick covers one window), which matters
    // only because the backfill endpoint is the rate-limited one.
    backfillLogRangeMaxBlocks: intEnv('BACKFILL_LOG_RANGE_MAX_BLOCKS', 50_000_000),
    contracts,
    startBlock: BigInt(intEnv('START_BLOCK', MONAD_TESTNET_START_BLOCK)),
    port: intEnv('PORT', 8787),
    dbPath: env('DB_PATH') ?? './data/indexer.db',
    allowedOrigins: (env('ALLOWED_ORIGINS') ?? 'http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter((origin) => origin !== ''),
    pollIntervalMs: intEnv('POLL_INTERVAL_MS', 1_000),
    logRangeMaxBlocks: intEnv('LOG_RANGE_MAX_BLOCKS', 100),
    catchupConcurrency: intEnv('CATCHUP_CONCURRENCY', 4),
    reorgDepthBlocks: intEnv('REORG_DEPTH_BLOCKS', 128),
  };
}
