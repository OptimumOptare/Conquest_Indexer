/**
 * Service configuration. Everything is an env var with a sane default except `RPC_HTTP`,
 * which has none on purpose: an indexer pointed at the wrong chain is worse than one that
 * refuses to boot.
 *
 * The contract addresses default to the T58 Monad-testnet deployment recorded in the UI's
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

export type ContractName =
  | 'adminController'
  | 'playerRegistry'
  | 'economy'
  | 'combat'
  | 'techWeapons'
  | 'diplomacy';

export const CONTRACT_NAMES: readonly ContractName[] = [
  'adminController',
  'playerRegistry',
  'economy',
  'combat',
  'techWeapons',
  'diplomacy',
];

/** T58 redeploy, Monad testnet (10143). Mirrors the UI address book. */
const MONAD_TESTNET_CONTRACTS: Record<ContractName, string> = {
  adminController: '0xD88E2085D19666707600480b37D53D8294c26bE7',
  playerRegistry: '0x8Ed9A59A097683064E6421cC37230656C0ccA800',
  economy: '0xF03301044D2C5b90A16353e4D76b6cE8d6F1e629',
  combat: '0xD08C80b9358cbEEB018Eb5863d2AfD22DA762310',
  techWeapons: '0xF3b42B4754b6e79400Df77ADAF07030F34026819',
  diplomacy: '0xC443014E6f1d47Acb766e93A299997E5Ca4Cc8a1',
};

/** AdminController creation block — the deploy anchor the browser must never crawl from. */
const MONAD_TESTNET_START_BLOCK = 51_988_283;

export type Config = {
  readonly chainId: number;
  readonly rpcHttp: string;
  readonly contracts: Record<ContractName, `0x${string}`>;
  readonly startBlock: bigint;
  readonly port: number;
  readonly dbPath: string;
  /** Exact origins allowed to read this service (UD22). Empty ⇒ no CORS header at all. */
  readonly allowedOrigins: readonly string[];
  readonly pollIntervalMs: number;
  /**
   * Provider cap on one `eth_getLogs` span. **Measured 100** on `testnet-rpc.monad.xyz`
   * (2026-08-15): a 1,000-block range is rejected with "eth_getLogs is limited to a 100 range".
   * Q-U36 recorded 1,000 when it was measured; the public endpoint has tightened since. Keyed
   * providers allow more — raise this there, it is the single biggest lever on catch-up time.
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
    catchupConcurrency: intEnv('CATCHUP_CONCURRENCY', 8),
    reorgDepthBlocks: intEnv('REORG_DEPTH_BLOCKS', 128),
  };
}
