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
};

export function createRpcClient(config: Config): PublicClient {
  return createPublicClient({
    transport: http(config.rpcHttp, { batch: false, retryCount: 2 }),
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
): Ingestor {
  const addresses = CONTRACT_NAMES.map(
    (name) => config.contracts[name] as Address,
  );
  const contractsByAddress = new Map<string, ContractName>(
    CONTRACT_NAMES.map((name) => [config.contracts[name].toLowerCase(), name]),
  );
  const rangeMax = BigInt(config.logRangeMaxBlocks);

  let stopped = false;
  const status: IngestStatus = {
    headBlock: store.headBlock(),
    chainTip: 0n,
    catchingUp: true,
    lastError: null,
    lastTickAt: null,
  };

  async function fetchRange(from: bigint, to: bigint): Promise<StoredLog[]> {
    const chunks = rangeChunks(from, to, rangeMax);
    const out: StoredLog[] = [];
    for (let i = 0; i < chunks.length; i += config.catchupConcurrency) {
      const slice = chunks.slice(i, i + config.catchupConcurrency);
      const batches = await Promise.all(
        slice.map((chunk) =>
          client.getLogs({
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

    const maxWindow = rangeMax * BigInt(config.catchupConcurrency);
    const windowEnd = cursor.nextFrom + maxWindow - 1n;
    const toBlock = windowEnd < tip ? windowEnd : tip;

    const logs = await fetchRange(cursor.nextFrom, toBlock);
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
