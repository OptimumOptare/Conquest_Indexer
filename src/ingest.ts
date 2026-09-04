/**
 * Ingest loop — `eth_getLogs` over the six game contracts, reorg-tolerant, cursor in SQLite.
 *
 * This is the crawl the browser must never do (UD21 / arch §5: no client-side backfill is ever
 * O(chain history)). Doing it once, here, is the entire point of the service.
 *
 * Ranges stay at or under `logRangeMaxBlocks` because the public Monad RPC rejects wider spans
 * (Q-U36), and the catch-up runs a few ranges concurrently. Steady state is one request per
 * poll: the tail is only a handful of blocks wide on ~0.4 s block times.
 */

import {
  createPublicClient,
  decodeEventLog,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import adminControllerAbi from './abis/AdminController.json' with { type: 'json' };
import combatAbi from './abis/Combat.json' with { type: 'json' };
import diplomacyAbi from './abis/Diplomacy.json' with { type: 'json' };
import economyAbi from './abis/Economy.json' with { type: 'json' };
import playerRegistryAbi from './abis/PlayerRegistry.json' with { type: 'json' };
import techWeaponsAbi from './abis/TechWeapons.json' with { type: 'json' };
import { categorizeEvent } from './catalog.js';
import { CONTRACT_NAMES, type Config, type ContractName } from './config.js';
import type { Cursor, Store, StoredLog } from './db.js';

const ABIS: Record<ContractName, Abi> = {
  adminController: adminControllerAbi as Abi,
  playerRegistry: playerRegistryAbi as Abi,
  economy: economyAbi as Abi,
  combat: combatAbi as Abi,
  techWeapons: techWeaponsAbi as Abi,
  diplomacy: diplomacyAbi as Abi,
};

export type IngestStatus = {
  headBlock: bigint;
  chainTip: bigint;
  catchingUp: boolean;
  lastError: string | null;
  lastTickAt: number | null;
  /** `eth_getLogs` calls sent to the wide-range backfill endpoint since boot. */
  backfillRequests: number;
};

export function createRpcClient(config: Config): PublicClient {
  return createPublicClient({
    transport: http(config.rpcHttp, { batch: false, retryCount: 2 }),
  });
}

/**
 * Wide-range `eth_getLogs` client, or null when none is configured.
 *
 * Kept separate from the steady-state client on purpose: the backfill endpoint is chosen for
 * range, not for rate. HyperRPC answers a 2M-block range in one request but its free tier allows
 * 5 requests/minute — fine for a once-per-cold-start backfill, hopeless for a 1 s poll. Routing
 * only the big `getLogs` here keeps both properties.
 */
export function createBackfillClient(config: Config): PublicClient | null {
  if (config.backfillRpcHttp === null) return null;
  return createPublicClient({
    transport: http(config.backfillRpcHttp, { batch: false, retryCount: 2 }),
  });
}

/** Log → storable row. Unknown address / uncataloged event / undecodable ⇒ null (dropped). */
export function toStoredLog(
  log: {
    address: string;
    topics: readonly Hex[];
    data: Hex;
    blockNumber: bigint | null;
    blockHash: Hex | null;
    transactionHash: Hex | null;
    logIndex: number | null;
  },
  contractsByAddress: ReadonlyMap<string, ContractName>,
): StoredLog | null {
  if (
    log.blockNumber === null ||
    log.blockHash === null ||
    log.transactionHash === null ||
    log.logIndex === null ||
    log.topics.length === 0
  ) {
    return null;
  }

  const contract = contractsByAddress.get(log.address.toLowerCase());
  if (contract === undefined) return null;

  let eventName: string;
  try {
    const decoded = decodeEventLog({
      abi: ABIS[contract],
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
      strict: false,
    }) as { eventName: string };
    eventName = decoded.eventName;
  } catch {
    return null;
  }

  const category = categorizeEvent(eventName);
  if (category === null) return null;

  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    eventName,
    category,
  };
}

function rangeChunks(
  from: bigint,
  to: bigint,
  maxSpan: bigint,
): { from: bigint; to: bigint }[] {
  const chunks: { from: bigint; to: bigint }[] = [];
  let cursor = from;
  while (cursor <= to) {
    const end = cursor + maxSpan - 1n;
    chunks.push({ from: cursor, to: end > to ? to : end });
    cursor = end + 1n;
  }
  return chunks;
}

export type Ingestor = {
  /** One catch-up window or tail step. Returns rows written. */
  tick: () => Promise<number>;
  start: () => Promise<void>;
  stop: () => void;
  status: () => IngestStatus;
};

export function createIngestor(
  config: Config,
  store: Store,
  client: Pick<PublicClient, 'getBlockNumber' | 'getBlock' | 'getLogs'>,
  backfillClient: Pick<PublicClient, 'getLogs'> | null = null,
): Ingestor {
  const addresses = CONTRACT_NAMES.map(
    (name) => config.contracts[name] as Address,
  );
  const contractsByAddress = new Map<string, ContractName>(
    CONTRACT_NAMES.map((name) => [config.contracts[name].toLowerCase(), name]),
  );
  const rangeMax = BigInt(config.logRangeMaxBlocks);

  const backfillRangeMax = BigInt(config.backfillLogRangeMaxBlocks);

  let stopped = false;
  const status: IngestStatus = {
    headBlock: store.headBlock(),
    chainTip: 0n,
    catchingUp: true,
    lastError: null,
    lastTickAt: null,
    backfillRequests: 0,
  };

  async function fetchRange(
    from: bigint,
    to: bigint,
    viaBackfill: boolean,
  ): Promise<StoredLog[]> {
    const source = viaBackfill && backfillClient !== null ? backfillClient : client;
    const chunks = rangeChunks(
      from,
      to,
      viaBackfill ? backfillRangeMax : rangeMax,
    );
    // The backfill endpoint is rate-limited, not range-limited: never fan out on it.
    const concurrency = viaBackfill ? 1 : config.catchupConcurrency;
    const out: StoredLog[] = [];
    for (let i = 0; i < chunks.length; i += concurrency) {
      const slice = chunks.slice(i, i + concurrency);
      if (viaBackfill) status.backfillRequests += slice.length;
      const batches = await Promise.all(
        slice.map((chunk) =>
          source.getLogs({
            address: addresses,
            fromBlock: chunk.from,
            toBlock: chunk.to,
          }),
        ),
      );
      for (const batch of batches) {
        for (const log of batch) {
          const stored = toStoredLog(log, contractsByAddress);
          if (stored !== null) out.push(stored);
        }
      }
    }
    return out.sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : a.blockNumber < b.blockNumber
          ? -1
          : 1,
    );
  }

  /** Parent-hash check on the block below the cursor — the same rule `logs.ts` uses. */
  async function detectReorg(cursor: Cursor): Promise<boolean> {
    if (cursor.confirmedHash === null || cursor.nextFrom === 0n) return false;
    const block = await client.getBlock({ blockNumber: cursor.nextFrom - 1n });
    return block.hash.toLowerCase() !== cursor.confirmedHash.toLowerCase();
  }

  async function rewind(cursor: Cursor): Promise<void> {
    const depth = BigInt(config.reorgDepthBlocks);
    const floor = config.startBlock;
    const target = cursor.nextFrom > depth ? cursor.nextFrom - depth : 0n;
    const rewindTo = target < floor ? floor : target;

    const confirmedHash =
      rewindTo > floor
        ? (await client.getBlock({ blockNumber: rewindTo - 1n })).hash
        : null;

    store.rewind(rewindTo, { nextFrom: rewindTo, confirmedHash });
    status.headBlock = store.headBlock();
  }

  async function tick(): Promise<number> {
    const tip = await client.getBlockNumber();
    status.chainTip = tip;

    const cursor = store.getCursor();
    if (await detectReorg(cursor)) {
      await rewind(cursor);
      return 0;
    }

    if (cursor.nextFrom > tip) {
      status.catchingUp = false;
      status.lastTickAt = Date.now();
      return 0;
    }

    // Route by gap, not by phase: if the steady-state endpoint would need more than one
    // request to close it, this is a backfill (cold start, or a long outage) and belongs on
    // the wide-range endpoint. At the tip the gap is ~3 blocks, so the tail never touches it.
    const gap = tip - cursor.nextFrom + 1n;
    const viaBackfill = backfillClient !== null && gap > rangeMax;

    const maxWindow = viaBackfill
      ? backfillRangeMax
      : rangeMax * BigInt(config.catchupConcurrency);
    const windowEnd = cursor.nextFrom + maxWindow - 1n;
    const toBlock = windowEnd < tip ? windowEnd : tip;

    const logs = await fetchRange(cursor.nextFrom, toBlock, viaBackfill);
    const confirmed = await client.getBlock({ blockNumber: toBlock });
    store.commit(logs, {
      nextFrom: toBlock + 1n,
      confirmedHash: confirmed.hash,
    });

    status.headBlock = toBlock;
    status.catchingUp = toBlock < tip;
    status.lastTickAt = Date.now();
    return logs.length;
  }

  async function start(): Promise<void> {
    stopped = false;
    while (!stopped) {
      try {
        await tick();
        status.lastError = null;
      } catch (error) {
        status.lastError =
          error instanceof Error ? error.message : String(error);
      }
      if (stopped) return;
      // Catching up? Go straight to the next window. At the tip? Wait a poll.
      if (!status.catchingUp || status.lastError !== null) {
        await new Promise((resolve) =>
          setTimeout(resolve, config.pollIntervalMs),
        );
      }
    }
  }

  return {
    tick,
    start,
    stop() {
      stopped = true;
    },
    status() {
      return { ...status };
    },
  };
}
