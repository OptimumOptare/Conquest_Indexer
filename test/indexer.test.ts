import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  multicall3Abi,
  type Abi,
  type AbiEvent,
  type Hex,
} from 'viem';
import coreAbi from '../src/abis/SchizoCore.json' with { type: 'json' };
import lensAbi from '../src/abis/SchizoLens.json' with { type: 'json' };
import { catalogEvents, categorizeEvent, FEED_BUFFER_LIMITS } from '../src/catalog.js';
import type { Config } from '../src/config.js';
import { openStore, type Store, type StoredLog } from '../src/db.js';
import { createHttpHandler } from '../src/server.js';
import { createIngestor, toStoredLog } from '../src/ingest.js';
import type { IngestStatus, Ingestor } from '../src/ingest.js';
import { troopPresencePairs } from '../src/indexes.js';
import {
  assertLeaderboardTriggers,
  createLeaderboard,
  LEADER_PAID_ARGS,
  playerTriggers,
} from '../src/leaderboard.js';
import {
  assertTriggerCatalog,
  createPositions,
  troopTriggers,
  TROOP_TRIGGER_ARGS,
} from '../src/positions.js';
import { POLICY_NATION_ARGS, policyNations, policyNationTopics } from '../src/policy.js';

const CHAIN = 10_143;
const PLAYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const CORE = '0x38036CAec40984A0A065C5eBa47BB63A06be4cd9' as const;
const LENS = '0xD3D04E9E10565587A20c9Bb7D69bE58e3F4383f6' as const;
const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

const config: Config = {
  chainId: CHAIN,
  rpcHttp: 'http://rpc.invalid',
  contracts: { core: CORE, lens: LENS },
  startBlock: 100n,
  port: 0,
  dbPath: ':memory:',
  allowedOrigins: ['https://play.example'],
  pollIntervalMs: 1,
  logRangeMaxBlocks: 1_000,
  catchupConcurrency: 2,
  reorgDepthBlocks: 8,
  backfillRpcHttp: null,
  backfillLogRangeMaxBlocks: 1_000_000,
  multicall3: MULTICALL,
  // Tiny batches, so every /positions test also exercises the chunking.
  positionsBatchCalls: 2,
  positionsSweepMs: 60_000,
  // Same for /leaderboard: three players already take two getPlayer batches.
  leaderboardBatchCalls: 2,
  leaderboardCallGas: 30_000_000n,
  leaderboardSweepMs: 60_000,
};

function hash(n: number): Hex {
  return `0x${n.toString(16).padStart(64, '0')}` as Hex;
}

function rpcLog(args: {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  logIndex: number;
}) {
  return {
    address: args.address,
    topics: args.topics,
    data: args.data,
    blockNumber: args.blockNumber,
    blockHash: hash(Number(args.blockNumber)),
    transactionHash: hash(9_000 + args.logIndex),
    logIndex: args.logIndex,
  };
}

function recruited(blockNumber: bigint, logIndex: number) {
  return rpcLog({
    address: CORE,
    topics: encodeEventTopics({
      abi: coreAbi as Abi,
      eventName: 'TroopsRecruited',
      args: { player: PLAYER, province: 1 },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [100n, 90n],
    ),
    blockNumber,
    logIndex,
  });
}

function roundReset(blockNumber: bigint, logIndex: number) {
  return rpcLog({
    address: CORE,
    topics: encodeEventTopics({
      abi: coreAbi as Abi,
      eventName: 'RoundReset',
      args: { roundId: 2n },
    }) as Hex[],
    data: '0x',
    blockNumber,
    logIndex,
  });
}

function stored(log: ReturnType<typeof recruited>): StoredLog {
  const result = toStoredLog(log, CORE);
  if (result === null) throw new Error('expected a cataloged log');
  return result;
}

/** Minimal in-memory chain: blocks 100..tip, logs at fixed heights. */
function fakeChain(logs: ReturnType<typeof recruited>[], tip = 110n) {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      getBlockNumber: async () => tip,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        number: blockNumber,
        hash: hash(Number(blockNumber)),
        parentHash: hash(Number(blockNumber) - 1),
      }),
      getLogs: async ({
        fromBlock,
        toBlock,
      }: {
        fromBlock: bigint;
        toBlock: bigint;
      }) => {
        calls += 1;
        return logs.filter(
          (log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock,
        );
      },
    },
  };
}

describe('§16 catalog', () => {
  it('categorizes cataloged events and drops everything else', () => {
    expect(categorizeEvent('TroopsRecruited')).toBe('activity');
    expect(categorizeEvent('WeaponDeployed')).toBe('news');
    expect(categorizeEvent('WarDeclared')).toBe('policy');
    expect(categorizeEvent('RoundReset')).toBe('meta');
    expect(categorizeEvent('RoleGranted')).toBeNull();
  });

  it('D45 TreasuryCaptured is meta; D46 OfferTaken is the market ring, and nothing else of the market is', () => {
    expect(categorizeEvent('TreasuryCaptured')).toBe('meta');
    expect(categorizeEvent('OfferTaken')).toBe('market');
    expect(catalogEvents('market')).toEqual(['OfferTaken']);
    expect(FEED_BUFFER_LIMITS.market).toBe(200);
    for (const name of ['OfferOpened', 'OfferCancelled', 'OffersVoided']) {
      expect(categorizeEvent(name)).toBeNull();
    }
  });
});

describe('log decoding', () => {
  it('keeps a cataloged log from a known contract', () => {
    const result = toStoredLog(recruited(101n, 0), CORE);
    expect(result?.eventName).toBe('TroopsRecruited');
    expect(result?.category).toBe('activity');
  });

  it('drops a log from any address other than SchizoCore', () => {
    const foreign = {
      ...recruited(101n, 0),
      address: '0x00000000000000000000000000000000deadbeef',
    };
    expect(toStoredLog(foreign, CORE)).toBeNull();
    // The lens is read-only code: a log claiming to come from it is not a game event.
    expect(toStoredLog({ ...recruited(101n, 0), address: LENS }, CORE)).toBeNull();
  });

  it('matches the core address case-insensitively', () => {
    const lowered = { ...recruited(101n, 0), address: CORE.toLowerCase() };
    expect(toStoredLog(lowered, CORE)?.eventName).toBe('TroopsRecruited');
  });

  it('drops an undecodable log', () => {
    const garbled = { ...recruited(101n, 0), topics: [hash(7)] as Hex[] };
    expect(toStoredLog(garbled, CORE)).toBeNull();
  });
});

describe('store', () => {
  it('serves the newest events per category, round-scoped', () => {
    const store = openStore(':memory:', 100n);
    store.commit(
      [
        stored(recruited(101n, 0)),
        stored(roundReset(105n, 0)),
        stored(recruited(106n, 0)),
      ],
      { nextFrom: 107n, confirmedHash: hash(106) },
    );

    const logs = store.snapshotLogs();
    // Everything below the RoundReset is a finished round — feeds flush at reset (07.2).
    expect(logs.map((log) => log.blockNumber)).toEqual(['105', '106']);
    expect(store.roundStartBlock()).toBe(105);
    expect(store.headBlock()).toBe(106n);
    store.close();
  });

  it('caps each category at the UD11 ring limits', () => {
    const store = openStore(':memory:', 100n);
    const many: StoredLog[] = [];
    const overflow = FEED_BUFFER_LIMITS.activity + 25;
    for (let i = 0; i < overflow; i++) {
      many.push(stored(recruited(BigInt(200 + i), 0)));
    }
    store.commit(many, { nextFrom: 400n, confirmedHash: hash(399) });

    expect(store.snapshotLogs()).toHaveLength(FEED_BUFFER_LIMITS.activity);
    store.close();
  });

  it('serves deltas strictly above `since`', () => {
    const store = openStore(':memory:', 100n);
    store.commit(
      [stored(recruited(101n, 0)), stored(recruited(103n, 0))],
      { nextFrom: 104n, confirmedHash: hash(103) },
    );

    const page = store.eventsSince(101n, 2_000);
    expect(page.logs.map((log) => log.blockNumber)).toEqual(['103']);
    expect(page.asOfBlock).toBe(103n);
    store.close();
  });

  it('trims an over-cap delta to a whole block', () => {
    const store = openStore(':memory:', 100n);
    store.commit(
      [
        stored(recruited(101n, 0)),
        stored(recruited(102n, 0)),
        stored(recruited(102n, 1)),
        stored(recruited(103n, 0)),
      ],
      { nextFrom: 104n, confirmedHash: hash(103) },
    );

    // Cap of 2 would cut block 102 in half; the response must stop below it.
    const page = store.eventsSince(100n, 2);
    expect(page.asOfBlock).toBe(101n);
    expect(page.logs.map((log) => log.blockNumber)).toEqual(['101']);
    store.close();
  });

  it('reports a reorg to clients that already hold the invalidated blocks', () => {
    const store = openStore(':memory:', 100n);
    store.commit([stored(recruited(105n, 0))], {
      nextFrom: 111n,
      confirmedHash: hash(110),
    });
    store.rewind(105n, { nextFrom: 105n, confirmedHash: hash(104) });

    expect(store.eventsSince(104n, 10).logs).toHaveLength(0);
    expect(store.reorgFrom(110n)).toBe(105n);
    expect(store.reorgFrom(105n)).toBe(105n);
    // A client that never got past 104 was never told anything wrong.
    expect(store.reorgFrom(104n)).toBeNull();
    store.close();
  });

  it('stops reporting a reorg once the cursor is past the head it rewound from', () => {
    const store = openStore(':memory:', 100n);
    store.commit([stored(recruited(105n, 0))], { nextFrom: 111n, confirmedHash: hash(110) });
    store.rewind(105n, { nextFrom: 105n, confirmedHash: hash(104) });
    store.commit([stored(recruited(106n, 0))], { nextFrom: 130n, confirmedHash: hash(129) });

    // Cursors above 110 were handed out after the rewind. Telling them again would wipe
    // everything they hold above 104 on every poll.
    expect(store.reorgFrom(111n)).toBeNull();
    expect(store.reorgFrom(129n)).toBeNull();
    store.close();
  });

  it('never reports reorg rows recorded before head_at existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'schizo-indexer-'));
    const dbPath = join(dir, 'legacy.db');
    try {
      const legacy = new Database(dbPath);
      legacy.exec(
        'CREATE TABLE reorgs (block_num INTEGER PRIMARY KEY, seen_at INTEGER NOT NULL);' +
          'INSERT INTO reorgs (block_num, seen_at) VALUES (105, 1);',
      );
      legacy.close();

      const store = openStore(dbPath, 100n);
      expect(store.reorgFrom(110n)).toBeNull();

      // Rewinds recorded on the migrated table are reported as usual.
      store.commit([stored(recruited(120n, 0))], { nextFrom: 126n, confirmedHash: hash(125) });
      store.rewind(120n, { nextFrom: 120n, confirmedHash: hash(119) });
      expect(store.reorgFrom(125n)).toBe(120n);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ingest', () => {
  it('catches up to the tip and then idles', async () => {
    const store = openStore(':memory:', 100n);
    const chain = fakeChain([recruited(101n, 0), recruited(109n, 0)], 110n);
    const ingestor = createIngestor(config, store, chain.client as never);

    await ingestor.tick();

    expect(store.eventCount()).toBe(2);
    expect(store.headBlock()).toBe(110n);
    expect(ingestor.status().catchingUp).toBe(false);

    const before = chain.calls();
    await ingestor.tick();
    // At the tip there is nothing to ask for.
    expect(chain.calls()).toBe(before);
    store.close();
  });

  it('rewinds and drops orphaned events when the parent hash does not match', async () => {
    const store = openStore(':memory:', 100n);
    store.commit([stored(recruited(105n, 0))], {
      nextFrom: 106n,
      // Deliberately wrong: block 105 hashes to something else on the canonical chain.
      confirmedHash: hash(999),
    });

    const chain = fakeChain([], 110n);
    const ingestor = createIngestor(config, store, chain.client as never);
    await ingestor.tick();

    expect(store.eventCount()).toBe(0);
    expect(store.getCursor().nextFrom).toBe(100n);
    store.close();
  });
});

describe('rpc routing (rate-limited backfill endpoint)', () => {
  /** Counts getLogs calls and the widest range each endpoint was asked for. */
  function countingLogs() {
    const spans: number[] = [];
    return {
      spans,
      client: {
        getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
          spans.push(Number(toBlock - fromBlock + 1n));
          return [];
        },
      },
    };
  }

  const wide: Config = {
    ...config,
    startBlock: 100n,
    backfillRpcHttp: 'https://backfill.invalid',
    logRangeMaxBlocks: 100,
  };

  it('sends a cold-start backfill to the wide endpoint in one request', async () => {
    const store = openStore(':memory:', 100n);
    const backfill = countingLogs();
    const tail = countingLogs();
    const chain = { ...fakeChain([], 50_100n).client, getLogs: tail.client.getLogs };
    const ingestor = createIngestor(wide, store, chain as never, backfill.client as never);

    await ingestor.tick();

    // 50,000 blocks behind: one wide request, and the rate-limited endpoint sees nothing else.
    expect(backfill.spans).toEqual([50_001]);
    expect(tail.spans).toEqual([]);
    expect(ingestor.status().backfillRequests).toBe(1);
    store.close();
  });

  it('keeps the tail off the rate-limited endpoint entirely', async () => {
    const store = openStore(':memory:', 100n);
    store.commit([], { nextFrom: 108n, confirmedHash: hash(107) });
    const backfill = countingLogs();
    const tail = countingLogs();
    const chain = { ...fakeChain([], 110n).client, getLogs: tail.client.getLogs };
    const ingestor = createIngestor(wide, store, chain as never, backfill.client as never);

    await ingestor.tick();

    // A 3-block gap fits one tail request, so the backfill endpoint is never called.
    expect(tail.spans).toEqual([3]);
    expect(backfill.spans).toEqual([]);
    expect(ingestor.status().backfillRequests).toBe(0);
    store.close();
  });

  it('falls back to the tail endpoint when no backfill endpoint is configured', async () => {
    const store = openStore(':memory:', 100n);
    const tail = countingLogs();
    const chain = { ...fakeChain([], 500n).client, getLogs: tail.client.getLogs };
    const ingestor = createIngestor(wide, store, chain as never, null);

    await ingestor.tick();

    // One tick covers rangeMax x concurrency = 200 blocks as two capped requests, all on the
    // tail endpoint; the remaining 200 blocks take further ticks. This is the slow path the
    // backfill endpoint exists to avoid.
    expect(tail.spans).toEqual([100, 100]);
    expect(store.getCursor().nextFrom).toBe(300n);
    expect(ingestor.status().backfillRequests).toBe(0);
    store.close();
  });
});

describe('http surface', () => {
  const status: IngestStatus = {
    headBlock: 106n,
    chainTip: 110n,
    catchingUp: false,
    lastError: null,
    lastTickAt: Date.now(),
    backfillRequests: 0,
  };
  const idleStore = openStore(':memory:', 100n);
  const idlePositions = createPositions(config, idleStore, {} as never);
  const ingestor = {
    status: () => status,
    positions: idlePositions,
    leaderboard: createLeaderboard(config, idleStore, {} as never, idlePositions),
  } as unknown as Ingestor;

  async function call(
    path: string,
    origin?: string,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> {
    const store = openStore(':memory:', 100n);
    store.commit(
      [stored(recruited(101n, 0)), stored(recruited(103n, 0))],
      { nextFrom: 104n, confirmedHash: hash(103) },
    );
    const handler = createHttpHandler(config, store, ingestor);

    return new Promise((resolve) => {
      const headers: Record<string, string> = {};
      let statusCode = 0;
      const res = {
        writeHead(code: number, sent: Record<string, string>) {
          statusCode = code;
          Object.assign(headers, sent);
        },
        end(payload?: string) {
          store.close();
          resolve({
            status: statusCode,
            headers,
            body:
              payload === undefined
                ? {}
                : (JSON.parse(payload) as Record<string, unknown>),
          });
        },
      };
      handler(
        { method: 'GET', url: path, headers: origin ? { origin } : {} } as never,
        res as never,
      );
    });
  }

  it('serves /snapshot with the block it is current as of', async () => {
    const response = await call('/snapshot');
    expect(response.status).toBe(200);
    expect(response.body.chainId).toBe(CHAIN);
    expect(response.body.asOfBlock).toBe('103');
    expect(response.body.logs).toHaveLength(2);
  });

  it('serves /events?since=', async () => {
    const response = await call('/events?since=101');
    expect(response.status).toBe(200);
    expect(response.body.logs).toHaveLength(1);
    expect(response.body.logs[0].blockNumber).toBe('103');
  });

  it('re-serves /events from a reorg, then stops reporting it past the rewound head', async () => {
    const store = openStore(':memory:', 100n);
    store.commit([stored(recruited(103n, 0)), stored(recruited(107n, 0))], {
      nextFrom: 111n,
      confirmedHash: hash(110),
    });
    store.rewind(105n, { nextFrom: 105n, confirmedHash: hash(104) });
    store.commit([stored(recruited(106n, 0)), stored(recruited(112n, 0))], {
      nextFrom: 120n,
      confirmedHash: hash(119),
    });

    // A cursor from before the rewind: drop above 104, and get the canonical 106 back.
    const stale = await request(store, '/events?since=110');
    expect(stale.body.reorgFrom).toBe('105');
    expect((stale.body.logs as { blockNumber: string }[]).map((log) => log.blockNumber)).toEqual([
      '106',
      '112',
    ]);
    expect(stale.body.asOfBlock).toBe('119');

    // The cursor that response handed out is past 110: no reorg, only new logs.
    const next = await request(store, '/events?since=119');
    expect(next.body.reorgFrom).toBeUndefined();
    expect(next.body.logs).toEqual([]);
    store.close();
  });

  it('rejects a missing/garbage since', async () => {
    expect((await call('/events')).status).toBe(400);
    expect((await call('/events?since=abc')).status).toBe(400);
  });

  it('answers the allowed site origin and nobody else (UD22)', async () => {
    const allowed = await call('/snapshot', 'https://play.example');
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'https://play.example',
    );

    const stranger = await call('/snapshot', 'https://evil.example');
    // No CORS header at all: the browser refuses to hand the body to the page.
    expect(stranger.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reports lag on /health', async () => {
    const response = await call('/health');
    expect(response.status).toBe(200);
    expect(response.body.lagBlocks).toBe('4');
  });
});

// --- U22.1: /players + /presence (UD24) -------------------------------------------------------

// ALICE and BOB are lowercase and sort as named. LEADER is mixed case, so every assertion on it
// also checks that the wire lowercases addresses.
const ALICE = '0xa11ce00000000000000000000000000000000000' as const;
const BOB = '0xb0b0000000000000000000000000000000000000' as const;
const LEADER = '0x1EADe20000000000000000000000000000000001' as const;

/** Any SchizoCore event, encoded the way the chain would emit it. */
function coreLog(
  eventName: string,
  args: Record<string, unknown>,
  blockNumber: bigint,
  logIndex = 0,
) {
  const item = (coreAbi as Abi).find(
    (entry): entry is AbiEvent => entry.type === 'event' && entry.name === eventName,
  );
  if (item === undefined) throw new Error(`no event ${eventName}`);
  const indexed = Object.fromEntries(
    item.inputs.filter((input) => input.indexed).map((input) => [input.name, args[input.name ?? '']]),
  );
  const plain = item.inputs.filter((input) => !input.indexed);
  return rpcLog({
    address: CORE,
    topics: encodeEventTopics({ abi: [item], eventName, args: indexed } as never) as Hex[],
    data: encodeAbiParameters(plain, plain.map((input) => args[input.name ?? ''])),
    blockNumber,
    logIndex,
  });
}

/** D46 — `takerNation` bought a Nuke from `sellerNation` for 500 gold, paid by `taker`. */
const offerTaken = (
  sellerNation: number,
  takerNation: number,
  taker: string,
  block: bigint,
  logIndex = 0,
) =>
  coreLog(
    'OfferTaken',
    {
      sellerNation,
      slot: 0,
      takerNation,
      taker,
      giveAsset: 2,
      giveWeaponId: 7,
      giveAmount: 1n,
      payAsset: 3,
      payAmount: 500n,
    },
    block,
    logIndex,
  );
const registered = (player: string, block: bigint, logIndex = 0) =>
  coreLog('PlayerRegistered', { player }, block, logIndex);
const recruitedAt = (player: string, province: number, block: bigint, logIndex = 0) =>
  coreLog('TroopsRecruited', { player, province, requested: 10n, arrived: 10n }, block, logIndex);
const moved = (player: string, from: number, to: number, block: bigint, logIndex = 0) =>
  coreLog(
    'TroopsMoved',
    { player, fromProvince: from, toProvince: to, sent: 5n, arrived: 5n },
    block,
    logIndex,
  );
const attacked = (
  attacker: string,
  from: number,
  to: number,
  conquered: boolean,
  block: bigint,
  logIndex = 0,
) =>
  coreLog(
    'AttackResolved',
    {
      attacker,
      fromProvince: from,
      toProvince: to,
      troopsSent: 5n,
      defendersKilled: 1n,
      conquered,
      morale: 1n,
    },
    block,
    logIndex,
  );
const burned = (player: string, province: number, block: bigint, logIndex = 0) =>
  coreLog('TroopsBurned', { player, province, troops: 1n, goldRefunded: 0n }, block, logIndex);
const necromancy = (
  nationId: number,
  troopsRevived: bigint,
  forfeited: boolean,
  block: bigint,
  logIndex = 0,
) => coreLog('NecromancyResolved', { nationId, troopsRevived, forfeited }, block, logIndex);
const resetTo = (roundId: bigint, block: bigint, logIndex = 0) =>
  coreLog('RoundReset', { roundId }, block, logIndex);

const caughtUp: IngestStatus = {
  headBlock: 0n,
  chainTip: 0n,
  catchingUp: false,
  lastError: null,
  lastTickAt: 1,
  backfillRequests: 0,
};

/** One request against a prepared store. The store stays open for the caller. */
function request(
  store: Store,
  path: string,
  status: IngestStatus = caughtUp,
): Promise<{ status: number; headers: Record<string, string>; body: Record<string, unknown> }> {
  return respond(
    createHttpHandler(config, store, { status: () => status } as unknown as Ingestor),
    path,
  );
}

/** One GET from the site origin through `handler`. */
function respond(
  handler: ReturnType<typeof createHttpHandler>,
  path: string,
): Promise<{ status: number; headers: Record<string, string>; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    let statusCode = 0;
    handler(
      { method: 'GET', url: path, headers: { origin: 'https://play.example' } } as never,
      {
        writeHead(code: number, sent: Record<string, string>) {
          statusCode = code;
          Object.assign(headers, sent);
        },
        end(payload?: string) {
          resolve({
            status: statusCode,
            headers,
            body: payload === undefined ? {} : (JSON.parse(payload) as Record<string, unknown>),
          });
        },
      } as never,
    );
  });
}

function commitAll(store: Store, logs: ReturnType<typeof coreLog>[], nextFrom: bigint): void {
  store.commit(logs.map(stored), { nextFrom, confirmedHash: hash(Number(nextFrom) - 1) });
}

/** Fake lens: `getNations` at any block, nation `id` at index `id - 1`. Records every call. */
function fakeLens(nations: { leader: string; capital: number }[]) {
  const calls: { address: string; functionName: string; blockNumber: bigint }[] = [];
  return {
    calls,
    readContract: async (args: { address: string; functionName: string; blockNumber: bigint }) => {
      calls.push({
        address: args.address,
        functionName: args.functionName,
        blockNumber: args.blockNumber,
      });
      return nations;
    },
  };
}

describe('troop presence extraction (port of the UI troopPresence.ts)', () => {
  it('yields the same pairs the UI derives, lowercased', () => {
    const store = openStore(':memory:', 100n);
    commitAll(
      store,
      [
        recruitedAt(ALICE, 1, 101n),
        burned(ALICE, 9, 101n, 1),
        moved(BOB, 2, 3, 102n),
        // Both ends, conquering or not: a superset is harmless, a missing pair is not.
        attacked(BOB, 3, 4, false, 103n),
        attacked(LEADER, 5, 6, true, 103n, 1),
      ],
      104n,
    );
    expect(store.presence()).toEqual({
      [ALICE]: [1, 9],
      [BOB]: [2, 3, 4],
      [LEADER.toLowerCase()]: [5, 6],
    });
    store.close();
  });

  it('skips malformed args and non-troop events instead of guessing', () => {
    expect(troopPresencePairs('TroopsRecruited', { player: ALICE, province: 0 })).toEqual([]);
    expect(troopPresencePairs('TroopsRecruited', { player: 'nope', province: 1 })).toEqual([]);
    expect(troopPresencePairs('PlayerRegistered', { player: ALICE })).toEqual([]);
  });
});

describe('/players (UD24)', () => {
  it('keeps a player registered before the latest RoundReset', async () => {
    const store = openStore(':memory:', 100n);
    commitAll(store, [registered(ALICE, 101n), resetTo(2n, 105n), registered(BOB, 106n)], 107n);

    const response = await request(store, '/players');
    expect(response.status).toBe(200);
    // The Registry is never reset (AGENTS rule 4); a round floor here was the original bug.
    expect(response.body.players).toEqual([ALICE, BOB]);
    expect(response.body.roundId).toBe('2');
    store.close();
  });

  it('keeps trades in their own ring: 250 registrations do not evict a take (D46)', async () => {
    const store = openStore(':memory:', 100n);
    const logs: ReturnType<typeof coreLog>[] = [offerTaken(7, 4, BOB, 101n)];
    for (let i = 1; i <= FEED_BUFFER_LIMITS.meta + 50; i++) {
      logs.push(registered(`0x${i.toString(16).padStart(40, '0')}`, BigInt(101 + i)));
    }
    commitAll(store, logs, 400n);

    const snapshot = await request(store, '/snapshot');
    expect(snapshot.body.logs).toHaveLength(FEED_BUFFER_LIMITS.meta + 1);
    expect(snapshot.body.logs.some((log: { blockNumber: string }) => log.blockNumber === '101')).toBe(
      true,
    );
    store.close();
  });

  it('returns every registration past the 200-row meta ring', async () => {
    const store = openStore(':memory:', 100n);
    const count = FEED_BUFFER_LIMITS.meta + 50;
    const expected: string[] = [];
    const logs: ReturnType<typeof coreLog>[] = [];
    for (let i = 1; i <= count; i++) {
      const player = `0x${i.toString(16).padStart(40, '0')}`;
      expected.push(player);
      logs.push(registered(player, BigInt(100 + i)));
    }
    commitAll(store, logs, BigInt(101 + count));

    // The feed ring still caps at 200 — that is the list the browser used to build from.
    const snapshot = await request(store, '/snapshot');
    expect(snapshot.body.logs).toHaveLength(FEED_BUFFER_LIMITS.meta);

    const response = await request(store, '/players');
    expect(response.body.players).toEqual(expected);
    store.close();
  });

  it('carries the wire envelope: chainId, roundId, asOfBlock as strings, no-store, CORS', async () => {
    const store = openStore(':memory:', 100n);
    commitAll(store, [registered(ALICE, 101n)], 104n);

    const response = await request(store, '/players');
    expect(response.body).toEqual({
      chainId: CHAIN,
      // Round 1 is opened by SchizoCore's constructor; there is no RoundReset for it.
      roundId: '1',
      asOfBlock: '103',
      players: [ALICE],
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBe('https://play.example');
    store.close();
  });
});

describe('/presence (UD24)', () => {
  it('empties at a RoundReset and refills', async () => {
    const store = openStore(':memory:', 100n);
    commitAll(store, [recruitedAt(ALICE, 1, 101n), moved(ALICE, 1, 2, 102n)], 103n);
    expect((await request(store, '/presence')).body.presence).toEqual({ [ALICE]: [1, 2] });

    commitAll(store, [resetTo(2n, 105n)], 106n);
    const emptied = await request(store, '/presence');
    expect(emptied.body.presence).toEqual({});
    expect(emptied.body.roundId).toBe('2');

    commitAll(store, [recruitedAt(BOB, 7, 107n), recruitedAt(ALICE, 1, 108n)], 109n);
    expect((await request(store, '/presence')).body.presence).toEqual({
      [ALICE]: [1],
      [BOB]: [7],
    });
    store.close();
  });

  it('splits a batch that straddles a RoundReset by log order', async () => {
    const store = openStore(':memory:', 100n);
    commitAll(
      store,
      [recruitedAt(ALICE, 1, 101n), resetTo(2n, 102n), recruitedAt(BOB, 2, 102n, 1)],
      103n,
    );
    expect((await request(store, '/presence')).body.presence).toEqual({ [BOB]: [2] });
    store.close();
  });

  it('answers 503 { catchingUp: true } instead of a partial body', async () => {
    const store = openStore(':memory:', 100n);
    commitAll(store, [recruitedAt(ALICE, 1, 101n), registered(ALICE, 101n, 1)], 102n);

    for (const path of ['/players', '/presence']) {
      const response = await request(store, path, { ...caughtUp, catchingUp: true });
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ catchingUp: true });
    }
    store.close();
  });
});

describe('index rewind (reorg)', () => {
  it('drops pairs first seen in the rewound range and keeps older ones', () => {
    const store = openStore(':memory:', 100n);
    commitAll(store, [registered(ALICE, 101n), recruitedAt(ALICE, 1, 101n, 1)], 102n);
    commitAll(
      store,
      [
        registered(BOB, 106n),
        recruitedAt(BOB, 2, 106n, 1),
        // Seen again inside the rewound range, but first proven at 101: still true.
        recruitedAt(ALICE, 1, 107n),
      ],
      108n,
    );

    store.rewind(105n, { nextFrom: 105n, confirmedHash: hash(104) });

    expect(store.players()).toEqual([ALICE]);
    expect(store.presence()).toEqual({ [ALICE]: [1] });
    store.close();
  });

  it('restores the previous round when the RoundReset itself is rewound', () => {
    const store = openStore(':memory:', 100n);
    commitAll(store, [recruitedAt(ALICE, 1, 101n)], 102n);
    commitAll(store, [resetTo(2n, 106n), recruitedAt(BOB, 2, 107n)], 108n);
    expect(store.presence()).toEqual({ [BOB]: [2] });

    store.rewind(105n, { nextFrom: 105n, confirmedHash: hash(104) });

    expect(store.currentRound()).toEqual({ roundId: 1n, startBlock: 0 });
    expect(store.presence()).toEqual({ [ALICE]: [1] });
    store.close();
  });
});

describe('necromancy pair (Q-U19)', () => {
  const nations = [
    { leader: '0x0000000000000000000000000000000000000001', capital: 10 },
    { leader: '0x0000000000000000000000000000000000000002', capital: 20 },
    { leader: LEADER, capital: 42 },
  ];

  it('adds (leader, capital) read from the lens at the log block', async () => {
    const store = openStore(':memory:', 100n);
    const lens = fakeLens(nations);
    const chain = fakeChain([necromancy(3, 50n, false, 105n)], 110n);
    const ingestor = createIngestor(
      config,
      store,
      { ...chain.client, readContract: lens.readContract } as never,
    );

    await ingestor.tick();

    expect(lens.calls).toEqual([
      { address: LENS, functionName: 'getNations', blockNumber: 105n },
    ]);
    expect(store.presence()).toEqual({ [LEADER.toLowerCase()]: [42] });
    store.close();
  });

  it('adds nothing, and reads nothing, for a forfeited or empty window', async () => {
    const store = openStore(':memory:', 100n);
    const lens = fakeLens(nations);
    const chain = fakeChain(
      [necromancy(3, 50n, true, 105n), necromancy(2, 0n, false, 106n), recruitedAt(ALICE, 1, 107n)],
      110n,
    );
    const ingestor = createIngestor(
      config,
      store,
      { ...chain.client, readContract: lens.readContract } as never,
    );

    await ingestor.tick();

    // No eth_call except the necromancy read, and that only for a window that revived troops.
    expect(lens.calls).toEqual([]);
    expect(store.presence()).toEqual({ [ALICE]: [1] });
    store.close();
  });

  it('refuses to commit the batch when the lens has no such nation', async () => {
    const store = openStore(':memory:', 100n);
    const lens = fakeLens(nations.slice(0, 2));
    const chain = fakeChain([necromancy(3, 50n, false, 105n)], 110n);
    const ingestor = createIngestor(
      config,
      store,
      { ...chain.client, readContract: lens.readContract } as never,
    );

    await expect(ingestor.tick()).rejects.toThrow(/no nation 3/);
    // Nothing committed: the cursor did not move, so the next tick retries the same range.
    expect(store.getCursor().nextFrom).toBe(100n);
    expect(store.eventCount()).toBe(0);
    store.close();
  });
});

describe('index backfill on boot', () => {
  it('rebuilds players and presence from stored events, without a chain crawl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schizo-indexer-'));
    const dbPath = join(dir, 'indexer.db');
    try {
      const before = openStore(dbPath, 100n);
      commitAll(
        before,
        [
          registered(ALICE, 101n),
          recruitedAt(ALICE, 1, 101n, 1),
          resetTo(2n, 103n),
          registered(BOB, 104n),
          moved(BOB, 2, 3, 104n, 1),
        ],
        105n,
      );
      // A necromancy credit's pair comes from the lens, so the commit carries it in.
      before.commit([stored(necromancy(3, 5n, false, 106n))], {
        nextFrom: 107n,
        confirmedHash: hash(106),
      });
      before.close();

      // Turn it into a database from before U22.1: events, no indexes.
      const raw = new Database(dbPath);
      raw.exec("DROP TABLE players; DROP TABLE presence; DELETE FROM meta WHERE key = 'indexes'");
      raw.close();

      const store = openStore(dbPath, 100n);
      expect(store.indexesReady()).toBe(false);
      expect((await request(store, '/players')).status).toBe(503);

      const lens = fakeLens([
        { leader: ALICE, capital: 1 },
        { leader: ALICE, capital: 1 },
        { leader: LEADER, capital: 42 },
      ]);
      const chain = fakeChain([], 106n);
      let getLogsCalls = 0;
      const ingestor = createIngestor(config, store, {
        ...chain.client,
        getLogs: async () => {
          getLogsCalls += 1;
          return [];
        },
        readContract: lens.readContract,
      } as never);

      await ingestor.ensureIndexes();

      expect(getLogsCalls).toBe(0);
      expect(lens.calls).toEqual([
        { address: LENS, functionName: 'getNations', blockNumber: 106n },
      ]);
      expect(store.indexesReady()).toBe(true);
      expect(store.players()).toEqual([ALICE, BOB]);
      expect(store.presence()).toEqual({ [BOB]: [2, 3], [LEADER.toLowerCase()]: [42] });

      // Built once: the next boot does not read the lens again.
      await ingestor.ensureIndexes();
      expect(lens.calls).toHaveLength(1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a fresh database as already built', () => {
    const store = openStore(':memory:', 100n);
    expect(store.indexesReady()).toBe(true);
    store.close();
  });
});

// --- U22.3: /positions (UD24 cached chain reads) -----------------------------------------------

type ChainLog = ReturnType<typeof coreLog>;

const ZERO = '0x0000000000000000000000000000000000000000';

/** `nationCountTotal` on every fake chain: `getPlayer` is asked for exactly these ids. */
const NATION_COUNT = 3;

/** The `getPlayer` fields /leaderboard serves; `shares` is per nation id. */
type PlayerFields = {
  nickname?: string;
  cp?: bigint;
  gold?: bigint;
  shares?: Record<number, bigint>;
};

/** A full `SchizoLens.PlayerView`, zero wherever the leaderboard does not look. */
function playerView(state: Required<PlayerFields>, nationIds: readonly number[]) {
  return {
    registered: true,
    gold: state.gold,
    level: 1,
    conquestPoints: state.cp,
    pfpId: 0,
    nickname: state.nickname,
    faucet: {
      lastClaim: 0n,
      streak: 0,
      level: 1,
      nextPayout: 0n,
      faucetCollection: ZERO,
      holdsCollectionNft: false,
      cooldown: 0n,
      claimableAt: 0n,
      eligible: false,
      gate: 0,
    },
    holdings: nationIds.map((nationId) => ({
      nationId,
      shares: state.shares[nationId] ?? 0n,
      // Not served: a nonzero value here proves the row ignores it.
      pendingGold: 1_000n,
      controlled: 0n,
      isLeader: false,
    })),
  };
}

const conquered = (province: number, byPlayer: string, block: bigint, logIndex = 0) =>
  coreLog('ProvinceConquered', { province, fromNation: 1, toNation: 2, byPlayer }, block, logIndex);
const destroyed = (province: number, block: bigint, logIndex = 0) =>
  coreLog('ProvinceDestroyed', { province }, block, logIndex);
const revived = (province: number, block: bigint, logIndex = 0) =>
  coreLog('ProvinceRevived', { province }, block, logIndex);
const infected = (province: number, block: bigint, logIndex = 0) =>
  coreLog('InfectionSpread', { province, infectedSince: 1n }, block, logIndex);
const deployed = (target: number, block: bigint, logIndex = 0) =>
  coreLog('WeaponDeployed', { nationId: 1, weaponId: 5, target }, block, logIndex);
const ticked = (folded: bigint, block: bigint, logIndex = 0) =>
  coreLog('TickAdvanced', { tick: 3n, stamped: 0n, folded }, block, logIndex);

/**
 * A chain that grows block by block. Logs, `effectiveTroops` state and the block hash are all
 * per block, so a read at block N sees what the chain held at N and nothing later. Every
 * multicall sub-call is recorded with the block it was read at.
 */
function troopChain(
  options: {
    adjacency?: Record<number, number[]>;
    nations?: { leader: string; capital: number }[];
  } = {},
) {
  let tip = 100n;
  let fork = 0;
  let failures = 0;
  const logs: ChainLog[] = [];
  const writes: { block: bigint; key: string; troops: bigint }[] = [];
  const reads: { block: bigint; fn: string; key: string }[] = [];
  const batchSizes: number[] = [];
  // /leaderboard (U22.4): getPlayer state, leaders, and every lens / leader read.
  let callFailures = 0;
  const playerWrites: { block: bigint; player: string; fields: PlayerFields }[] = [];
  const leaderWrites: { block: bigint; nation: number; leader: string }[] = [];
  const boardReads: { block: bigint; fn: string; key: string }[] = [];
  const callGas: bigint[] = [];
  const playerBatchSizes: number[] = [];

  const playerAt = (player: string, block: bigint): Required<PlayerFields> => {
    const out: Required<PlayerFields> = { nickname: '', cp: 0n, gold: 0n, shares: {} };
    for (const write of playerWrites) {
      if (write.player === player && write.block <= block) Object.assign(out, write.fields);
    }
    return out;
  };
  const leaderAt = (nation: number, block: bigint): string => {
    let leader: string = ZERO;
    for (const write of leaderWrites) {
      if (write.nation === nation && write.block <= block) leader = write.leader;
    }
    return leader;
  };

  const troopsAt = (key: string, block: bigint): bigint => {
    let value = 0n;
    for (const write of writes) if (write.key === key && write.block <= block) value = write.troops;
    return value;
  };

  type Call = { address: string; functionName: string; args: readonly unknown[] };

  return {
    reads,
    batchSizes,
    boardReads,
    callGas,
    playerBatchSizes,
    client: {
      getBlockNumber: async () => tip,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        number: blockNumber,
        hash: hash(Number(blockNumber) + fork),
      }),
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
        logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock),
      readContract: async () => options.nations ?? [],
      multicall: async (args: {
        contracts: readonly Call[];
        blockNumber: bigint;
        allowFailure: boolean;
        multicallAddress: string;
        batchSize: number;
      }) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('rpc down');
        }
        // A partial answer must fail the whole read, and the block must be stated.
        expect(args.allowFailure).toBe(false);
        expect(args.multicallAddress).toBe(MULTICALL);
        expect(args.batchSize).toBe(0);
        expect(typeof args.blockNumber).toBe('bigint');
        batchSizes.push(args.contracts.length);
        return args.contracts.map((call) => {
          expect(call.address).toBe(CORE);
          const [province, player] = call.args as [number, string | undefined];
          if (call.functionName === 'nationCountTotal') {
            boardReads.push({ block: args.blockNumber, fn: 'nationCountTotal', key: '' });
            return NATION_COUNT;
          }
          if (call.functionName === 'leaderOf') {
            boardReads.push({ block: args.blockNumber, fn: 'leaderOf', key: `${province}` });
            return leaderAt(province, args.blockNumber);
          }
          if (call.functionName === 'neighborsOf') {
            reads.push({ block: args.blockNumber, fn: 'neighborsOf', key: `${province}` });
            return options.adjacency?.[province] ?? [];
          }
          if (call.functionName !== 'effectiveTroops' || player === undefined) {
            throw new Error(`unexpected call ${call.functionName}`);
          }
          const key = `${province}:${player.toLowerCase()}`;
          reads.push({ block: args.blockNumber, fn: 'effectiveTroops', key });
          return troopsAt(key, args.blockNumber);
        });
      },
      /** `aggregate3` of `SchizoLens.getPlayer`, sent raw so it can carry a gas limit. */
      call: async (args: { to: string; data: Hex; blockNumber: bigint; gas: bigint }) => {
        if (callFailures > 0) {
          callFailures -= 1;
          throw new Error('getPlayer rpc down');
        }
        expect(args.to).toBe(MULTICALL);
        expect(typeof args.blockNumber).toBe('bigint');
        callGas.push(args.gas);
        const outer = decodeFunctionData({ abi: multicall3Abi, data: args.data });
        expect(outer.functionName).toBe('aggregate3');
        const calls = (outer.args as unknown as [readonly { target: string; allowFailure: boolean; callData: Hex }[]])[0];
        playerBatchSizes.push(calls.length);
        const result = calls.map((sub) => {
          // A partial answer must fail the whole read.
          expect(sub.target).toBe(LENS);
          expect(sub.allowFailure).toBe(false);
          const inner = decodeFunctionData({ abi: lensAbi as Abi, data: sub.callData });
          expect(inner.functionName).toBe('getPlayer');
          const [address, nationIds] = inner.args as [string, readonly number[]];
          // Every nation, so `shares` sums the player's whole holding.
          expect(nationIds).toEqual(Array.from({ length: NATION_COUNT }, (_, i) => i + 1));
          const player = address.toLowerCase();
          boardReads.push({ block: args.blockNumber, fn: 'getPlayer', key: player });
          const state = playerAt(player, args.blockNumber);
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: lensAbi as Abi,
              functionName: 'getPlayer',
              result: playerView(state, nationIds),
            } as never),
          };
        });
        return {
          data: encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result }),
        };
      },
    },
    /** Mine `block`: its logs, and the troop state its transactions left behind. */
    mine(block: bigint, events: ChainLog[] = [], state: [number, string, bigint][] = []) {
      logs.push(...events);
      for (const [province, player, troops] of state) {
        writes.push({ block, key: `${province}:${player.toLowerCase()}`, troops });
      }
      tip = block;
    },
    /** `effectiveTroops` pairs read since the last drain, as `province:player@block`, sorted. */
    drain(): string[] {
      const out = reads
        .filter((read) => read.fn === 'effectiveTroops')
        .map((read) => `${read.key}@${read.block}`)
        .sort();
      reads.length = 0;
      return out;
    },
    failNext(count = 1) {
      failures += count;
    },
    /** Fail the next `getPlayer` batches; `effectiveTroops` reads are unaffected. */
    failNextCall(count = 1) {
      callFailures += count;
    },
    /** What `getPlayer` returns for `player` from `block` on. Unset fields keep their value. */
    player(block: bigint, player: string, fields: PlayerFields) {
      playerWrites.push({ block, player: player.toLowerCase(), fields });
    },
    /** `leaderOf(nation)` from `block` on. */
    lead(block: bigint, nation: number, leader: string) {
      leaderWrites.push({ block, nation, leader });
    },
    /** `getPlayer` reads since the last drain, as `player@block`, sorted. Clears the board log. */
    drainPlayers(): string[] {
      const out = boardReads
        .filter((read) => read.fn === 'getPlayer')
        .map((read) => `${read.key}@${read.block}`)
        .sort();
      boardReads.length = 0;
      return out;
    },
    /** Every block hash changes: the next tick sees a reorg below its cursor. */
    reorg() {
      fork += 1_000_000;
    },
  };
}

/** Store + positions cache + ingest loop over `chain`, with a hand-driven clock. */
function positionsRig(chain: ReturnType<typeof troopChain>) {
  const store = openStore(':memory:', 100n);
  const clock = { now: 1_000 };
  const lines = { info: [] as string[], warn: [] as string[] };
  const positions = createPositions(config, store, chain.client as never, {
    now: () => clock.now,
    logger: {
      info: (line) => lines.info.push(line),
      warn: (line) => lines.warn.push(line),
    },
  });
  // The leaderboard sweeps on the same clock, so it logs to its own sink.
  const boardLines = { info: [] as string[], warn: [] as string[] };
  const leaderboard = createLeaderboard(config, store, chain.client as never, positions, {
    now: () => clock.now,
    logger: {
      info: (line) => boardLines.info.push(line),
      warn: (line) => boardLines.warn.push(line),
    },
  });
  const ingestor = createIngestor(
    config,
    store,
    chain.client as never,
    null,
    positions,
    leaderboard,
  );
  const get = (path: string) => respond(createHttpHandler(config, store, ingestor), path);
  return { store, clock, lines, boardLines, positions, leaderboard, ingestor, get };
}

describe('/positions triggers (U22.3)', () => {
  const triggersOf = (log: ChainLog) => troopTriggers(stored(log));

  it('maps every trigger event to the provinces it dirties', () => {
    expect(triggersOf(recruitedAt(ALICE, 1, 101n)).provinces).toEqual([1]);
    expect(triggersOf(moved(ALICE, 2, 3, 101n)).provinces).toEqual([2, 3]);
    expect(triggersOf(burned(ALICE, 4, 101n)).provinces).toEqual([4]);
    expect(triggersOf(attacked(ALICE, 5, 6, false, 101n)).provinces).toEqual([5, 6]);
    expect(triggersOf(conquered(7, ALICE, 101n)).provinces).toEqual([7]);
    expect(triggersOf(destroyed(8, 101n)).provinces).toEqual([8]);
    expect(triggersOf(revived(9, 101n)).provinces).toEqual([9]);
    expect(triggersOf(infected(10, 101n)).provinces).toEqual([10]);

    // A nuke cuts every adjacent factor, so the target brings its neighbours along.
    expect(triggersOf(deployed(11, 101n))).toEqual({
      provinces: [11],
      withNeighbors: [11],
      infected: false,
      all: false,
    });
    // Decay folded into every infected province; a tick that folded nothing changed nothing.
    expect(triggersOf(ticked(2n, 101n)).infected).toBe(true);
    expect(triggersOf(ticked(0n, 101n))).toEqual(troopTriggers(stored(registered(ALICE, 101n))));
    // A new round holds nothing, so nothing cached carries over.
    expect(triggersOf(resetTo(2n, 101n)).all).toBe(true);
  });

  it('dirties nothing for events that cannot move troops', () => {
    const none = { provinces: [], withNeighbors: [], infected: false, all: false };
    expect(triggersOf(registered(ALICE, 101n))).toEqual(none);
    // NecromancyResolved is placed from the ingest loop's lens read, not by its own args.
    expect(triggersOf(necromancy(3, 5n, false, 101n))).toEqual(none);
  });

  it('refuses an ABI that renamed a trigger arg, so the trigger cannot silently stop firing', () => {
    expect(() => assertTriggerCatalog()).not.toThrow();
    const renamed = (coreAbi as Abi).map((item) =>
      item.type === 'event' && item.name === 'TroopsMoved'
        ? {
            ...item,
            inputs: item.inputs.map((input) =>
              input.name === 'toProvince' ? { ...input, name: 'to' } : input,
            ),
          }
        : item,
    );
    expect(() => assertTriggerCatalog(renamed as Abi)).toThrow(/TroopsMoved\.toProvince/);
    // Every trigger is a cataloged event, so it is stored and reaches the cache.
    for (const name of Object.keys(TROOP_TRIGGER_ARGS)) {
      expect(categorizeEvent(name)).not.toBeNull();
    }
  });
});

describe('/positions cache (U22.3)', () => {
  it('re-reads a TroopsMoved at the new head, both ends and nothing else', async () => {
    const chain = troopChain();
    const rig = positionsRig(chain);
    chain.mine(101n, [recruitedAt(ALICE, 1, 101n), recruitedAt(BOB, 5, 101n, 1)], [
      [1, ALICE, 10n],
      [5, BOB, 7n],
    ]);
    await rig.ingestor.tick();

    // First read is the full one, at the head ingest reached.
    expect(chain.drain()).toEqual(['1:' + ALICE + '@101', '5:' + BOB + '@101']);
    expect(rig.positions.view()).toEqual({
      roundId: 1n,
      asOfBlock: 101n,
      positions: { '1': { [ALICE]: '10' }, '5': { [BOB]: '7' } },
    });

    chain.mine(102n, [moved(ALICE, 1, 2, 102n)], [
      [1, ALICE, 6n],
      [2, ALICE, 4n],
    ]);
    await rig.ingestor.tick();

    // Serving the block-101 values here would be the stale cache this ticket exists to prevent.
    expect(rig.positions.view()).toEqual({
      roundId: 1n,
      asOfBlock: 102n,
      positions: {
        '1': { [ALICE]: '6' },
        '2': { [ALICE]: '4' },
        '5': { [BOB]: '7' },
      },
    });
    // Only the two provinces the move named were re-read, at the block it landed in.
    expect(chain.drain()).toEqual(['1:' + ALICE + '@102', '2:' + ALICE + '@102']);
    expect(chain.batchSizes.every((size) => size <= config.positionsBatchCalls)).toBe(true);
    rig.store.close();
  });

  it('advances asOfBlock with no reads when nothing was written', async () => {
    const chain = troopChain();
    const rig = positionsRig(chain);
    chain.mine(101n, [recruitedAt(ALICE, 1, 101n)], [[1, ALICE, 10n]]);
    await rig.ingestor.tick();
    chain.drain();

    chain.mine(105n, [registered(BOB, 104n)]);
    await rig.ingestor.tick();

    expect(chain.drain()).toEqual([]);
    expect(rig.positions.view()?.asOfBlock).toBe(105n);
    expect(rig.positions.view()?.positions).toEqual({ '1': { [ALICE]: '10' } });
    rig.store.close();
  });

  it('re-reads a nuke target and its neighbours, loading adjacency once', async () => {
    const chain = troopChain({ adjacency: { 3: [1, 2] } });
    const rig = positionsRig(chain);
    chain.mine(
      101n,
      [
        recruitedAt(ALICE, 1, 101n),
        recruitedAt(ALICE, 2, 101n, 1),
        recruitedAt(BOB, 3, 101n, 2),
        recruitedAt(BOB, 9, 101n, 3),
      ],
      [
        [1, ALICE, 100n],
        [2, ALICE, 100n],
        [3, BOB, 100n],
        [9, BOB, 100n],
      ],
    );
    await rig.ingestor.tick();
    chain.drain();

    chain.mine(102n, [deployed(3, 102n)], [
      [1, ALICE, 50n],
      [2, ALICE, 50n],
      [3, BOB, 0n],
    ]);
    await rig.ingestor.tick();

    expect(chain.drain()).toEqual([
      '1:' + ALICE + '@102',
      '2:' + ALICE + '@102',
      '3:' + BOB + '@102',
    ]);
    expect(rig.positions.view()?.positions).toEqual({
      '1': { [ALICE]: '50' },
      '2': { [ALICE]: '50' },
      '9': { [BOB]: '100' },
    });

    chain.mine(103n, [deployed(3, 103n)]);
    await rig.ingestor.tick();
    expect(chain.reads.filter((read) => read.fn === 'neighborsOf')).toEqual([]);
    expect(chain.drain()).toHaveLength(3);
    rig.store.close();
  });

  it('re-reads the capital a NecromancyResolved credited', async () => {
    const chain = troopChain({
      nations: [
        { leader: ALICE, capital: 10 },
        { leader: BOB, capital: 20 },
        { leader: LEADER, capital: 42 },
      ],
    });
    const rig = positionsRig(chain);
    chain.mine(101n, [recruitedAt(ALICE, 1, 101n)], [[1, ALICE, 10n]]);
    await rig.ingestor.tick();
    chain.drain();

    chain.mine(102n, [necromancy(3, 50n, false, 102n)], [[42, LEADER, 50n]]);
    await rig.ingestor.tick();

    expect(chain.drain()).toEqual(['42:' + LEADER.toLowerCase() + '@102']);
    expect(rig.positions.view()?.positions['42']).toEqual({ [LEADER.toLowerCase()]: '50' });
    rig.store.close();
  });

  it('refreshes infected provinces only on a TickAdvanced that folded decay', async () => {
    const chain = troopChain();
    const rig = positionsRig(chain);
    chain.mine(
      101n,
      [recruitedAt(ALICE, 1, 101n), recruitedAt(ALICE, 2, 101n, 1), recruitedAt(BOB, 3, 101n, 2)],
      [
        [1, ALICE, 100n],
        [2, ALICE, 100n],
        [3, BOB, 100n],
      ],
    );
    await rig.ingestor.tick();
    chain.mine(102n, [infected(2, 102n), infected(3, 102n, 1)]);
    await rig.ingestor.tick();
    chain.drain();

    // A tick before the clock runs folds nothing, and nothing is read.
    chain.mine(103n, [ticked(0n, 103n)]);
    await rig.ingestor.tick();
    expect(chain.drain()).toEqual([]);

    chain.mine(104n, [ticked(2n, 104n)], [
      [2, ALICE, 90n],
      [3, BOB, 90n],
    ]);
    await rig.ingestor.tick();

    expect(chain.drain()).toEqual(['2:' + ALICE + '@104', '3:' + BOB + '@104']);
    expect(rig.positions.view()?.positions).toEqual({
      '1': { [ALICE]: '100' },
      '2': { [ALICE]: '90' },
      '3': { [BOB]: '90' },
    });

    // Infection alone is no trigger: a recruit elsewhere re-reads its own province only.
    chain.mine(105n, [recruitedAt(ALICE, 1, 105n)], [[1, ALICE, 110n]]);
    await rig.ingestor.tick();
    expect(chain.drain()).toEqual(['1:' + ALICE + '@105']);
    rig.store.close();
  });

  it('drops the old garrison to 0 and out of the output on a conquest', async () => {
    const chain = troopChain();
    const rig = positionsRig(chain);
    chain.mine(101n, [recruitedAt(ALICE, 5, 101n), recruitedAt(BOB, 6, 101n, 1)], [
      [5, ALICE, 30n],
      [6, BOB, 20n],
    ]);
    await rig.ingestor.tick();

    // The epoch bump orphans BOB's units: effectiveTroops reads 0 for him from here on.
    chain.mine(102n, [attacked(ALICE, 5, 6, true, 102n), conquered(6, ALICE, 102n, 1)], [
      [5, ALICE, 5n],
      [6, BOB, 0n],
      [6, ALICE, 8n],
    ]);
    await rig.ingestor.tick();

    expect(rig.positions.view()?.positions).toEqual({
      '5': { [ALICE]: '5' },
      '6': { [ALICE]: '8' },
    });
    expect(rig.positions.view({ player: BOB })?.positions).toEqual({});
    rig.store.close();
  });

  it('drops everything at a RoundReset and starts the new round empty', async () => {
    const chain = troopChain();
    const rig = positionsRig(chain);
    chain.mine(101n, [recruitedAt(ALICE, 1, 101n)], [[1, ALICE, 10n]]);
    await rig.ingestor.tick();
    chain.drain();

    chain.mine(102n, [resetTo(2n, 102n)], [[1, ALICE, 0n]]);
    await rig.ingestor.tick();
    expect(rig.positions.view()).toEqual({ roundId: 2n, asOfBlock: 102n, positions: {} });
    // The new round has no pairs yet, so the rebuild reads nothing.
    expect(chain.drain()).toEqual([]);

    chain.mine(103n, [recruitedAt(BOB, 4, 103n)], [[4, BOB, 3n]]);
    await rig.ingestor.tick();
    expect(rig.positions.view()?.positions).toEqual({ '4': { [BOB]: '3' } });
    rig.store.close();
  });

  it('serves nothing after a reorg rewind until it has re-read everything', async () => {
    const chain = troopChain();
    const rig = positionsRig(chain);
    chain.mine(101n, [recruitedAt(ALICE, 1, 101n)], [[1, ALICE, 10n]]);
    chain.mine(110n, [recruitedAt(BOB, 2, 110n)], [[2, BOB, 4n]]);
    await rig.ingestor.tick();
    expect(rig.positions.status().ready).toBe(true);
    chain.drain();

    chain.reorg();
    await rig.ingestor.tick();
    // The cached block may be orphaned: no body at all beats one that cannot be re-checked.
    expect(rig.positions.view()).toBeNull();
    expect((await rig.get('/positions')).status).toBe(503);

    await rig.ingestor.tick();
    expect(chain.drain()).toEqual(['1:' + ALICE + '@110', '2:' + BOB + '@110']);
    expect(rig.positions.view()?.asOfBlock).toBe(110n);
    rig.store.close();
  });

  it('keeps serving the previous snapshot at its own block when a read fails', async () => {
    const chain = troopChain();
    const rig = positionsRig(chain);
    chain.mine(101n, [recruitedAt(ALICE, 1, 101n)], [[1, ALICE, 10n]]);
    await rig.ingestor.tick();

    chain.mine(102n, [moved(ALICE, 1, 2, 102n)], [
      [1, ALICE, 6n],
      [2, ALICE, 4n],
    ]);
    chain.failNext();
    await rig.ingestor.tick();

    // Old values at the old block are still true. Old values at the new block would not be.
    expect(rig.positions.view()).toEqual({
      roundId: 1n,
      asOfBlock: 101n,
      positions: { '1': { [ALICE]: '10' } },
    });
    expect(rig.positions.status().lastError).toBe('rpc down');
    expect(rig.ingestor.status().lastError).toBeNull();

    // The dirty set survived the failure: an idle tick at the same head retries it.
    await rig.ingestor.tick();
    expect(rig.positions.view()?.asOfBlock).toBe(102n);
    expect(rig.positions.view()?.positions).toEqual({
      '1': { [ALICE]: '6' },
      '2': { [ALICE]: '4' },
    });
    expect(rig.positions.status().lastError).toBeNull();
    rig.store.close();
  });
});

describe('/positions safety sweep (U22.3)', () => {
  /** One block that fires every trigger, with the troop state each one leaves. */
  async function everyTrigger() {
    const chain = troopChain({
      adjacency: { 7: [8] },
      nations: [{ leader: LEADER, capital: 42 }],
    });
    const rig = positionsRig(chain);
    chain.mine(
      101n,
      [
        recruitedAt(ALICE, 1, 101n),
        recruitedAt(ALICE, 3, 101n, 1),
        recruitedAt(BOB, 4, 101n, 2),
        recruitedAt(BOB, 6, 101n, 3),
        recruitedAt(BOB, 8, 101n, 4),
        recruitedAt(BOB, 9, 101n, 5),
        infected(9, 101n, 6),
      ],
      [
        [1, ALICE, 50n],
        [3, ALICE, 40n],
        [4, BOB, 30n],
        [6, BOB, 20n],
        [8, BOB, 10n],
        [9, BOB, 90n],
      ],
    );
    await rig.ingestor.tick();

    chain.mine(
      102n,
      [
        moved(ALICE, 1, 2, 102n),
        burned(ALICE, 3, 102n, 1),
        attacked(ALICE, 2, 4, true, 102n, 2),
        conquered(4, ALICE, 102n, 3),
        destroyed(6, 102n, 4),
        revived(6, 102n, 5),
        deployed(7, 102n, 6),
        necromancy(1, 25n, false, 102n, 7),
        ticked(1n, 102n, 8),
      ],
      [
        [1, ALICE, 30n],
        [2, ALICE, 5n],
        [3, ALICE, 35n],
        [4, BOB, 0n],
        [4, ALICE, 12n],
        [6, BOB, 0n],
        [8, BOB, 7n],
        [42, LEADER, 25n],
        [9, BOB, 81n],
      ],
    );
    await rig.ingestor.tick();
    return { chain, rig };
  }

  it('reports 0 changes on a fixture where every trigger fired', async () => {
    const { chain, rig } = await everyTrigger();

    rig.clock.now += config.positionsSweepMs;
    chain.mine(103n);
    await rig.ingestor.tick();

    expect(rig.positions.status().lastSweep).toMatchObject({ block: 103n, changed: 0 });
    expect(rig.positions.status().sweepChangedTotal).toBe(0);
    expect(rig.lines.warn).toEqual([]);
    expect(rig.lines.info).toEqual([
      expect.stringMatching(/sweep at block 103: \d+ pairs re-read, 0 changed with no trigger/),
    ]);
    expect(rig.positions.view()?.positions).toEqual({
      '1': { [ALICE]: '30' },
      '2': { [ALICE]: '5' },
      '3': { [ALICE]: '35' },
      '4': { [ALICE]: '12' },
      '8': { [BOB]: '7' },
      '9': { [BOB]: '81' },
      '42': { [LEADER.toLowerCase()]: '25' },
    });
    rig.store.close();
  });

  it('reports, and corrects, a value that moved with no trigger', async () => {
    const { chain, rig } = await everyTrigger();

    // State changes with no log: exactly what a missing trigger looks like from here.
    chain.mine(103n, [], [[8, BOB, 1n]]);
    await rig.ingestor.tick();
    expect(rig.positions.view()?.positions['8']).toEqual({ [BOB]: '7' });

    rig.clock.now += config.positionsSweepMs;
    chain.mine(104n);
    await rig.ingestor.tick();

    expect(rig.positions.status().lastSweep).toMatchObject({ block: 104n, changed: 1 });
    expect(rig.lines.warn[0]).toMatch(/1 changed with no trigger\. A \/positions trigger is missing/);
    expect(rig.lines.warn[1]).toContain(`province 8 player ${BOB}: cached 7, chain 1`);
    expect(rig.positions.view()?.positions['8']).toEqual({ [BOB]: '1' });

    const health = await rig.get('/health');
    expect(health.body.positions).toMatchObject({
      ready: true,
      asOfBlock: '104',
      sweepChangedTotal: 1,
      lastSweep: { block: '104', changed: 1 },
    });
    rig.store.close();
  });

  it('does not count a province a trigger touched in the same refresh', async () => {
    const chain = troopChain();
    const rig = positionsRig(chain);
    chain.mine(101n, [recruitedAt(ALICE, 1, 101n)], [[1, ALICE, 10n]]);
    await rig.ingestor.tick();

    rig.clock.now += config.positionsSweepMs;
    chain.mine(102n, [recruitedAt(ALICE, 1, 102n)], [[1, ALICE, 20n]]);
    await rig.ingestor.tick();

    expect(rig.positions.status().lastSweep).toMatchObject({ block: 102n, changed: 0 });
    expect(rig.positions.view()?.positions).toEqual({ '1': { [ALICE]: '20' } });
    rig.store.close();
  });
});

describe('/positions route (U22.3)', () => {
  async function served() {
    const chain = troopChain();
    const rig = positionsRig(chain);
    chain.mine(
      101n,
      [recruitedAt(ALICE, 1, 101n), recruitedAt(BOB, 1, 101n, 1), recruitedAt(BOB, 2, 101n, 2)],
      [
        [1, ALICE, 10n],
        [1, BOB, 3n],
        [2, BOB, 0n],
      ],
    );
    return { chain, rig };
  }

  it('answers 503 { catchingUp: true } until the first full read is done', async () => {
    const { rig } = await served();
    const before = await rig.get('/positions');
    expect(before.status).toBe(503);
    expect(before.body).toEqual({ catchingUp: true });
    rig.store.close();
  });

  it('carries the wire envelope and nonzero entries only', async () => {
    const { rig } = await served();
    await rig.ingestor.tick();

    const response = await rig.get('/positions');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      chainId: CHAIN,
      roundId: '1',
      asOfBlock: '101',
      // BOB read 0 in province 2, so he is not in it.
      positions: { '1': { [ALICE]: '10', [BOB]: '3' } },
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBe('https://play.example');
    rig.store.close();
  });

  it('serves one province or one player as a slice of the same shape', async () => {
    const { rig } = await served();
    await rig.ingestor.tick();

    expect((await rig.get('/positions?province=1')).body.positions).toEqual({
      '1': { [ALICE]: '10', [BOB]: '3' },
    });
    expect((await rig.get('/positions?province=2')).body.positions).toEqual({});
    // Addresses match case-insensitively and come back lowercased.
    expect(
      (await rig.get(`/positions?player=${BOB.toUpperCase().replace('0X', '0x')}`)).body.positions,
    ).toEqual({ '1': { [BOB]: '3' } });
    expect((await rig.get(`/positions?province=1&player=${ALICE}`)).body.positions).toEqual({
      '1': { [ALICE]: '10' },
    });
    rig.store.close();
  });

  it('rejects a malformed province or player with 400', async () => {
    const { rig } = await served();
    await rig.ingestor.tick();

    for (const path of [
      '/positions?province=abc',
      '/positions?province=0',
      '/positions?province=65536',
      '/positions?province=',
      '/positions?player=nope',
      '/positions?player=0x1234',
    ]) {
      expect((await rig.get(path)).status).toBe(400);
    }
    rig.store.close();
  });

  it('leaves /snapshot and /events unchanged', async () => {
    const { rig } = await served();
    await rig.ingestor.tick();

    const snapshot = await rig.get('/snapshot');
    expect(Object.keys(snapshot.body).sort()).toEqual([
      'asOfBlock',
      'chainId',
      'logs',
      'roundStartBlock',
    ]);
    const events = await rig.get('/events?since=100');
    expect(Object.keys(events.body).sort()).toEqual(['asOfBlock', 'chainId', 'logs']);
    rig.store.close();
  });
});

// --- U22.4: /leaderboard (UD24 cached chain reads) ---------------------------------------------

const CAROL = '0xca201c0000000000000000000000000000000000' as const;

const leaderChanged = (nationId: number, oldLeader: string, newLeader: string, block: bigint, logIndex = 0) =>
  coreLog('LeaderChanged', { nationId, oldLeader, newLeader }, block, logIndex);
const delegateApproved = (player: string, delegate: string, block: bigint, logIndex = 0) =>
  coreLog('DelegateApproved', { player, delegate, permissions: 1, expiry: 9n }, block, logIndex);
const warDeclared = (byNation: number, onNation: number, block: bigint, logIndex = 0) =>
  coreLog('WarDeclared', { byNation, onNation, expiresAt: 9n }, block, logIndex);
const modeChanged = (nationId: number, block: bigint, logIndex = 0) =>
  coreLog('ModeChanged', { nationId, oldMode: 0, newMode: 1 }, block, logIndex);
const renamed = (nationId: number, block: bigint, logIndex = 0) =>
  coreLog('NationRenamed', { nationId, newName: 'Zion', admin: false }, block, logIndex);
const allianceProposed = (byNation: number, toNation: number, block: bigint, logIndex = 0) =>
  coreLog('AllianceProposed', { byNation, toNation, duration: 9n }, block, logIndex);
const goldPurchased = (player: string, block: bigint, logIndex = 0) =>
  coreLog('GoldPurchased', { player, monIn: 1n, goldOut: 5n, cp: 5n }, block, logIndex);
const goldHarvested = (player: string, block: bigint, logIndex = 0) =>
  coreLog('GoldHarvested', { player, nationId: 1, amount: 2n, cp: 2n }, block, logIndex);
const faucetClaimed = (player: string, block: bigint, logIndex = 0) =>
  coreLog(
    'FaucetClaimed',
    { player, goldAmount: 3n, cpAmount: 3n, streak: 1, viaCollection: ZERO },
    block,
    logIndex,
  );
const goldAirdropped = (player: string, block: bigint, logIndex = 0) =>
  coreLog('GoldAirdropped', { player, amount: 4n }, block, logIndex);
const cpAirdropped = (player: string, block: bigint, logIndex = 0) =>
  coreLog('CPAirdropped', { player, amount: 4n }, block, logIndex);
const nicknameSet = (player: string, nickname: string, block: bigint, logIndex = 0) =>
  coreLog('NicknameSet', { player, nickname, admin: false }, block, logIndex);

/** The served row for `player`, or undefined. */
function rowOf(rig: ReturnType<typeof positionsRig>, player: string) {
  return rig.leaderboard.view()?.rows.find((row) => row.player === player.toLowerCase());
}

describe('/leaderboard triggers (U22.4)', () => {
  const of = (log: ChainLog) => playerTriggers(stored(log));
  const none = { players: [], nations: [], all: false };

  it('dirties every address in an address-typed arg, taken from the ABI', () => {
    expect(of(recruitedAt(ALICE, 1, 101n))).toEqual({ players: [ALICE], nations: [], all: false });
    expect(of(attacked(BOB, 1, 2, true, 101n)).players).toEqual([BOB]);
    expect(of(conquered(2, LEADER, 101n)).players).toEqual([LEADER.toLowerCase()]);
    expect(of(leaderChanged(4, ALICE, BOB, 101n)).players).toEqual([ALICE, BOB]);
    // On no writer list anywhere: the rule is read off the ABI, so it still counts.
    expect(of(delegateApproved(ALICE, BOB, 101n)).players).toEqual([ALICE, BOB]);
    // An unclaimed nation's old leader is the zero address, which is nobody.
    expect(of(leaderChanged(4, ZERO, ALICE, 101n)).players).toEqual([ALICE]);
  });

  it('names the nation of every leader action that pays or earns with no address in its log', () => {
    expect(of(warDeclared(3, 5, 101n))).toEqual({ players: [], nations: [3], all: false });
    expect(of(modeChanged(2, 101n)).nations).toEqual([2]);
    expect(of(renamed(7, 101n)).nations).toEqual([7]);
    expect(of(allianceProposed(4, 6, 101n)).nations).toEqual([4]);
    expect(of(deployed(9, 101n)).nations).toEqual([1]);
  });

  it('a black-market take dirties the paying leader and the seller nation’s leader (D46)', () => {
    expect(of(offerTaken(7, 4, BOB, 101n))).toEqual({ players: [BOB], nations: [7], all: false });
  });

  it('re-reads everyone at a RoundReset, and nobody for a log with no player in it', () => {
    expect(of(resetTo(2n, 101n)).all).toBe(true);
    expect(of(ticked(2n, 101n))).toEqual(none);
    expect(of(infected(3, 101n))).toEqual(none);
    expect(of(necromancy(1, 5n, false, 101n))).toEqual(none);
  });

  it('refuses an ABI change that would silence a trigger', () => {
    expect(() => assertLeaderboardTriggers()).not.toThrow();
    const renameArg = (event: string, from: string, to: string) =>
      (coreAbi as Abi).map((item) =>
        item.type === 'event' && item.name === event
          ? {
              ...item,
              inputs: item.inputs.map((input) => (input.name === from ? { ...input, name: to } : input)),
            }
          : item,
      ) as Abi;
    expect(() => assertLeaderboardTriggers(renameArg('GoldPurchased', 'player', 'buyer'))).toThrow(
      /GoldPurchased\.player/,
    );
    expect(() => assertLeaderboardTriggers(renameArg('WarDeclared', 'byNation', 'by'))).toThrow(
      /WarDeclared\.byNation/,
    );
    for (const name of Object.keys(LEADER_PAID_ARGS)) {
      expect(categorizeEvent(name)).not.toBeNull();
    }
  });
});

describe('/leaderboard cache (U22.4)', () => {
  /** ALICE, BOB and LEADER registered at block 101, with ALICE's state set. */
  async function built() {
    const chain = troopChain();
    const rig = positionsRig(chain);
    chain.mine(101n, [
      registered(ALICE, 101n),
      registered(BOB, 101n, 1),
      registered(LEADER, 101n, 2),
      recruitedAt(ALICE, 1, 101n, 3),
    ], [[1, ALICE, 10n]]);
    chain.player(101n, ALICE, { nickname: 'alice', cp: 5n, gold: 7n, shares: { 1: 3n, 3: 4n } });
    await rig.ingestor.tick();
    return { chain, rig };
  }

  it('reads every registered player at the head on the first build, in gas-capped batches', async () => {
    const { chain, rig } = await built();

    expect(chain.drainPlayers()).toEqual([
      `${LEADER.toLowerCase()}@101`,
      `${ALICE}@101`,
      `${BOB}@101`,
    ]);
    expect(rig.leaderboard.view()).toEqual({
      roundId: 1n,
      asOfBlock: 101n,
      // Ascending by address, like /players.
      rows: [
        {
          player: LEADER.toLowerCase(),
          nickname: '',
          conquestPoints: '0',
          gold: '0',
          shares: '0',
          troops: '0',
        },
        // Shares summed over every nation's holding.
        { player: ALICE, nickname: 'alice', conquestPoints: '5', gold: '7', shares: '7', troops: '10' },
        // No activity at all, and still a row.
        { player: BOB, nickname: '', conquestPoints: '0', gold: '0', shares: '0', troops: '0' },
      ],
    });
    // Two batches under the cap, each with the explicit gas limit the public RPC needs.
    expect(chain.playerBatchSizes).toEqual([2, 1]);
    expect(chain.callGas).toEqual([config.leaderboardCallGas, config.leaderboardCallGas]);
    rig.store.close();
  });

  it('re-reads only the player a TroopsRecruited names, at the block it landed in', async () => {
    const { chain, rig } = await built();
    chain.drainPlayers();

    chain.mine(102n, [recruitedAt(ALICE, 2, 102n)], [[2, ALICE, 6n]]);
    chain.player(102n, ALICE, { gold: 6n, shares: { 1: 9n, 3: 4n } });
    await rig.ingestor.tick();

    expect(chain.drainPlayers()).toEqual([`${ALICE}@102`]);
    expect(rig.leaderboard.view()?.asOfBlock).toBe(102n);
    expect(rowOf(rig, ALICE)).toMatchObject({ gold: '6', shares: '13', troops: '16' });
    expect(rowOf(rig, BOB)).toMatchObject({ gold: '0', troops: '0' });
    rig.store.close();
  });

  it('serves troops as the sum of the player\'s /positions entries at the same block', async () => {
    const { chain, rig } = await built();
    chain.mine(102n, [moved(ALICE, 1, 2, 102n), recruitedAt(BOB, 1, 102n, 1)], [
      [1, ALICE, 6n],
      [2, ALICE, 3n],
      [1, BOB, 5n],
    ]);
    await rig.ingestor.tick();

    const positions = rig.positions.view();
    const sum = (player: string) =>
      Object.values(positions?.positions ?? {}).reduce(
        (total, holders) => total + BigInt(holders[player] ?? '0'),
        0n,
      );
    expect(positions?.asOfBlock).toBe(rig.leaderboard.view()?.asOfBlock);
    expect(rowOf(rig, ALICE)?.troops).toBe(sum(ALICE).toString());
    expect(rowOf(rig, BOB)?.troops).toBe(sum(BOB).toString());
    expect(rowOf(rig, ALICE)?.troops).toBe('9');
    rig.store.close();
  });

  it('advances asOfBlock with no reads when no log names a player', async () => {
    const { chain, rig } = await built();
    chain.drainPlayers();

    chain.mine(105n, [infected(9, 104n), ticked(0n, 105n)]);
    await rig.ingestor.tick();

    // Not even the nation count: nothing to read.
    expect(chain.boardReads).toEqual([]);
    expect(rig.leaderboard.view()?.asOfBlock).toBe(105n);
    expect(rowOf(rig, ALICE)).toMatchObject({ gold: '7', troops: '10' });
    rig.store.close();
  });

  it('follows /positions when troops move with no player named', async () => {
    const { chain, rig } = await built();
    chain.mine(102n, [infected(1, 102n)]);
    await rig.ingestor.tick();
    chain.drainPlayers();

    // Infection decay folds into ALICE's province. The log names no one, so her row is not
    // re-read, but its troops are /positions' at the new block.
    chain.mine(103n, [ticked(2n, 103n)], [[1, ALICE, 8n]]);
    await rig.ingestor.tick();

    expect(chain.boardReads).toEqual([]);
    expect(rig.leaderboard.view()?.asOfBlock).toBe(103n);
    expect(rowOf(rig, ALICE)).toMatchObject({ gold: '7', troops: '8' });
    rig.store.close();
  });

  it('re-reads the leader a leader action charged, though its log names no address', async () => {
    const { chain, rig } = await built();
    chain.lead(101n, 3, BOB);
    chain.lead(101n, 1, LEADER);
    chain.drainPlayers();

    // WarDeclared spends the leader's gold; WeaponDeployed grants the leader CP. Neither logs them.
    chain.mine(102n, [warDeclared(3, 2, 102n), deployed(9, 102n, 1)]);
    chain.player(102n, BOB, { gold: 40n });
    chain.player(102n, LEADER, { cp: 25n });
    await rig.ingestor.tick();

    expect(
      chain.boardReads.filter((read) => read.fn === 'leaderOf').map((read) => `${read.key}@${read.block}`).sort(),
    ).toEqual(['1@102', '3@102']);
    expect(chain.drainPlayers()).toEqual([`${LEADER.toLowerCase()}@102`, `${BOB}@102`]);
    expect(rowOf(rig, BOB)?.gold).toBe('40');
    expect(rowOf(rig, LEADER)?.conquestPoints).toBe('25');
    rig.store.close();
  });

  it('still re-reads the payer when leadership moved after the action in the same refresh', async () => {
    const { chain, rig } = await built();
    chain.lead(101n, 3, BOB);
    chain.drainPlayers();

    // BOB declares war and pays; ALICE takes the nation before the head. leaderOf now says ALICE,
    // and LeaderChanged names BOB.
    chain.mine(102n, [warDeclared(3, 2, 102n), leaderChanged(3, BOB, ALICE, 102n, 1)]);
    chain.lead(102n, 3, ALICE);
    chain.player(102n, BOB, { gold: 40n });
    await rig.ingestor.tick();

    expect(chain.drainPlayers()).toEqual([`${ALICE}@102`, `${BOB}@102`]);
    expect(rowOf(rig, BOB)?.gold).toBe('40');
    rig.store.close();
  });

  it('adds a row for a new registration', async () => {
    const { chain, rig } = await built();
    chain.drainPlayers();

    chain.mine(102n, [registered(CAROL, 102n)]);
    chain.player(102n, CAROL, { nickname: 'carol' });
    await rig.ingestor.tick();

    expect(chain.drainPlayers()).toEqual([`${CAROL}@102`]);
    expect(rig.leaderboard.view()?.rows.map((row) => row.player)).toEqual(
      [ALICE, BOB, CAROL, LEADER.toLowerCase()].sort(),
    );
    expect(rowOf(rig, CAROL)?.nickname).toBe('carol');
    rig.store.close();
  });

  it('reads a registered player it was never told about', async () => {
    // A registration the trigger path missed would otherwise be a /players address with no row.
    const chain = troopChain();
    const store = openStore(':memory:', 100n);
    const positions = createPositions(config, store, chain.client as never);
    const leaderboard = createLeaderboard(config, store, chain.client as never, positions);
    commitAll(store, [registered(ALICE, 101n)], 102n);
    await positions.refresh(101n);
    await leaderboard.refresh(101n);
    chain.drainPlayers();

    commitAll(store, [registered(BOB, 102n)], 103n);
    await positions.refresh(102n);
    await leaderboard.refresh(102n);

    expect(chain.drainPlayers()).toEqual([`${BOB}@102`]);
    expect(leaderboard.view()?.rows.map((row) => row.player)).toEqual([ALICE, BOB]);
    store.close();
  });

  it('zeroes round-scoped fields at a RoundReset and keeps the row', async () => {
    const { chain, rig } = await built();
    chain.player(101n, ALICE, { cp: 9n });
    chain.drainPlayers();

    // Gold and shares are round-scoped and read as lazy zeroes in the new round; CP and the
    // nickname live in the registry, which no reset touches.
    chain.mine(102n, [resetTo(2n, 102n)], [[1, ALICE, 0n]]);
    chain.player(102n, ALICE, { gold: 0n, shares: {} });
    await rig.ingestor.tick();

    expect(chain.drainPlayers()).toEqual([
      `${LEADER.toLowerCase()}@102`,
      `${ALICE}@102`,
      `${BOB}@102`,
    ]);
    expect(rig.leaderboard.view()?.roundId).toBe(2n);
    expect(rowOf(rig, ALICE)).toEqual({
      player: ALICE,
      nickname: 'alice',
      conquestPoints: '9',
      gold: '0',
      shares: '0',
      troops: '0',
    });
    expect(rig.leaderboard.view()?.rows).toHaveLength(3);
    rig.store.close();
  });

  it('waits for /positions, serving the previous rows at their own block meanwhile', async () => {
    const { chain, rig } = await built();
    chain.drainPlayers();

    chain.mine(102n, [recruitedAt(ALICE, 1, 102n)], [[1, ALICE, 20n]]);
    chain.player(102n, ALICE, { gold: 2n });
    chain.failNext();
    await rig.ingestor.tick();

    // /positions failed, so there is no `troops` at 102 to pair the new gold with.
    expect(rig.positions.view()?.asOfBlock).toBe(101n);
    expect(rig.leaderboard.view()?.asOfBlock).toBe(101n);
    expect(rowOf(rig, ALICE)).toMatchObject({ gold: '7', troops: '10' });
    expect(rig.leaderboard.status().lastError).toMatch(/\/positions has no read at block 102/);
    expect(chain.drainPlayers()).toEqual([]);

    await rig.ingestor.tick();
    expect(rig.leaderboard.view()?.asOfBlock).toBe(102n);
    expect(rowOf(rig, ALICE)).toMatchObject({ gold: '2', troops: '20' });
    expect(rig.leaderboard.status().lastError).toBeNull();
    rig.store.close();
  });

  it('keeps the previous rows at their own block when getPlayer fails, and retries', async () => {
    const { chain, rig } = await built();
    chain.drainPlayers();

    chain.mine(102n, [recruitedAt(ALICE, 1, 102n)], [[1, ALICE, 20n]]);
    chain.player(102n, ALICE, { gold: 2n });
    chain.failNextCall();
    await rig.ingestor.tick();

    // /positions moved on to 102. The rows did not, and their troops are still block 101's.
    expect(rig.positions.view()?.asOfBlock).toBe(102n);
    expect(rig.leaderboard.view()?.asOfBlock).toBe(101n);
    expect(rowOf(rig, ALICE)).toMatchObject({ gold: '7', troops: '10' });
    expect(rig.leaderboard.status()).toMatchObject({ lastError: 'getPlayer rpc down', dirtyPlayers: 1 });
    expect(rig.ingestor.status().lastError).toBeNull();

    await rig.ingestor.tick();
    expect(chain.drainPlayers()).toEqual([`${ALICE}@102`]);
    expect(rig.leaderboard.view()?.asOfBlock).toBe(102n);
    expect(rowOf(rig, ALICE)).toMatchObject({ gold: '2', troops: '20' });
    rig.store.close();
  });

  it('serves nothing after a reorg rewind until it has re-read everyone', async () => {
    const { chain, rig } = await built();
    chain.mine(110n, [recruitedAt(BOB, 2, 110n)], [[2, BOB, 4n]]);
    await rig.ingestor.tick();
    chain.drainPlayers();

    chain.reorg();
    await rig.ingestor.tick();
    expect(rig.leaderboard.view()).toBeNull();
    expect((await rig.get('/leaderboard')).status).toBe(503);

    await rig.ingestor.tick();
    expect(chain.drainPlayers()).toEqual([
      `${LEADER.toLowerCase()}@110`,
      `${ALICE}@110`,
      `${BOB}@110`,
    ]);
    expect(rig.leaderboard.view()?.asOfBlock).toBe(110n);
    expect(rowOf(rig, BOB)?.troops).toBe('4');
    rig.store.close();
  });
});

describe('/leaderboard safety sweep (U22.4)', () => {
  /**
   * One block where every writer of a served field fires. LEADER and CAROL are named by nothing
   * but a leader action, so the sweep only stays at 0 if the leader rule works.
   */
  async function everyWriter() {
    const chain = troopChain();
    const rig = positionsRig(chain);
    chain.mine(101n, [
      registered(ALICE, 101n),
      registered(BOB, 101n, 1),
      registered(CAROL, 101n, 2),
      registered(LEADER, 101n, 3),
    ]);
    chain.lead(101n, 1, LEADER);
    chain.lead(101n, 2, CAROL);
    await rig.ingestor.tick();

    chain.mine(
      102n,
      [
        goldPurchased(ALICE, 102n),
        recruitedAt(ALICE, 1, 102n, 1),
        goldAirdropped(ALICE, 102n, 2),
        cpAirdropped(ALICE, 102n, 3),
        goldHarvested(BOB, 102n, 4),
        burned(BOB, 1, 102n, 5),
        attacked(BOB, 1, 2, false, 102n, 6),
        faucetClaimed(BOB, 102n, 7),
        nicknameSet(BOB, 'bob', 102n, 8),
        deployed(9, 102n, 9),
        modeChanged(2, 102n, 10),
        warDeclared(2, 3, 102n, 11),
        renamed(2, 102n, 12),
        allianceProposed(2, 1, 102n, 13),
      ],
      [[1, ALICE, 30n]],
    );
    chain.player(102n, ALICE, { cp: 12n, gold: 3n, shares: { 1: 30n } });
    chain.player(102n, BOB, { nickname: 'bob', cp: 8n, gold: 6n });
    chain.player(102n, LEADER, { cp: 25n });
    chain.player(102n, CAROL, { gold: 1n });
    await rig.ingestor.tick();
    return { chain, rig };
  }

  it('reports 0 changes on a fixture where every writer fired', async () => {
    const { chain, rig } = await everyWriter();

    rig.clock.now += config.leaderboardSweepMs;
    chain.mine(103n);
    await rig.ingestor.tick();

    expect(rig.leaderboard.status().lastSweep).toMatchObject({ block: 103n, players: 4, changed: 0 });
    expect(rig.leaderboard.status().sweepChangedTotal).toBe(0);
    expect(rig.boardLines.warn).toEqual([]);
    expect(rig.boardLines.info).toEqual([
      'leaderboard sweep at block 103: 4 players re-read, 0 changed with no trigger',
    ]);
    expect(rig.leaderboard.view()?.rows).toEqual([
      { player: LEADER.toLowerCase(), nickname: '', conquestPoints: '25', gold: '0', shares: '0', troops: '0' },
      { player: ALICE, nickname: '', conquestPoints: '12', gold: '3', shares: '30', troops: '30' },
      { player: BOB, nickname: 'bob', conquestPoints: '8', gold: '6', shares: '0', troops: '0' },
      { player: CAROL, nickname: '', conquestPoints: '0', gold: '1', shares: '0', troops: '0' },
    ]);
    rig.store.close();
  });

  it('reports, and corrects, a row that moved with no trigger', async () => {
    const { chain, rig } = await everyWriter();

    // State changes with no log: exactly what a missing trigger looks like from here.
    chain.mine(103n);
    chain.player(103n, CAROL, { cp: 99n });
    await rig.ingestor.tick();
    expect(rowOf(rig, CAROL)?.conquestPoints).toBe('0');

    rig.clock.now += config.leaderboardSweepMs;
    chain.mine(104n);
    await rig.ingestor.tick();

    expect(rig.leaderboard.status().lastSweep).toMatchObject({ block: 104n, changed: 1 });
    expect(rig.boardLines.warn[0]).toMatch(/1 changed with no trigger\. A \/leaderboard trigger is missing/);
    expect(rig.boardLines.warn[1]).toBe(`  player ${CAROL}: conquestPoints cached 0, chain 99`);
    expect(rowOf(rig, CAROL)?.conquestPoints).toBe('99');

    const health = await rig.get('/health');
    expect(health.body.leaderboard).toMatchObject({
      ready: true,
      asOfBlock: '104',
      rows: 4,
      sweepChangedTotal: 1,
      lastSweep: { block: '104', players: 4, changed: 1 },
    });
    rig.store.close();
  });

  it('does not count a player a trigger named in the same refresh', async () => {
    const { chain, rig } = await everyWriter();

    rig.clock.now += config.leaderboardSweepMs;
    chain.mine(103n, [goldPurchased(CAROL, 103n)]);
    chain.player(103n, CAROL, { gold: 50n });
    await rig.ingestor.tick();

    expect(rig.leaderboard.status().lastSweep).toMatchObject({ block: 103n, changed: 0 });
    expect(rowOf(rig, CAROL)?.gold).toBe('50');
    rig.store.close();
  });
});

describe('/leaderboard route (U22.4)', () => {
  async function served() {
    const chain = troopChain();
    const rig = positionsRig(chain);
    chain.mine(101n, [registered(BOB, 101n), registered(ALICE, 101n, 1), recruitedAt(ALICE, 1, 101n, 2)], [
      [1, ALICE, 10n],
    ]);
    chain.player(101n, ALICE, { nickname: 'alice', cp: 123456789012345678901234567890n, gold: 4n, shares: { 2: 10n } });
    return { chain, rig };
  }

  it('answers 503 { catchingUp: true } until the first full read is done', async () => {
    const { rig } = await served();
    const before = await rig.get('/leaderboard');
    expect(before.status).toBe(503);
    expect(before.body).toEqual({ catchingUp: true });
    rig.store.close();
  });

  it('carries the wire envelope and one row per /players address, bigints as strings', async () => {
    const { rig } = await served();
    await rig.ingestor.tick();

    const response = await rig.get('/leaderboard');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      chainId: CHAIN,
      roundId: '1',
      asOfBlock: '101',
      rows: [
        {
          player: ALICE,
          nickname: 'alice',
          // Past 2^53: a JSON number would round it.
          conquestPoints: '123456789012345678901234567890',
          gold: '4',
          shares: '10',
          troops: '10',
        },
        { player: BOB, nickname: '', conquestPoints: '0', gold: '0', shares: '0', troops: '0' },
      ],
    });
    const players = await rig.get('/players');
    expect((response.body.rows as { player: string }[]).map((row) => row.player)).toEqual(players.body.players);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBe('https://play.example');
    rig.store.close();
  });

  it('leaves /snapshot, /events and /positions unchanged', async () => {
    const { rig } = await served();
    await rig.ingestor.tick();

    expect(Object.keys((await rig.get('/snapshot')).body).sort()).toEqual([
      'asOfBlock',
      'chainId',
      'logs',
      'roundStartBlock',
    ]);
    expect(Object.keys((await rig.get('/events?since=100')).body).sort()).toEqual([
      'asOfBlock',
      'chainId',
      'logs',
    ]);
    expect((await rig.get('/positions')).body).toEqual({
      chainId: CHAIN,
      roundId: '1',
      asOfBlock: '101',
      positions: { '1': { [ALICE]: '10' } },
    });
    rig.store.close();
  });
});

// --- U22.6: /policy?nation= (UD24 row 1) -------------------------------------------------------

const allianceFormed = (a: number, b: number, block: bigint, logIndex = 0) =>
  coreLog('AllianceFormed', { a, b, expiresAt: 9n }, block, logIndex);
const sharesDelegated = (nationId: number, from: string, to: string, block: bigint, logIndex = 0) =>
  coreLog('SharesDelegated', { nationId, from, to, amount: 1n }, block, logIndex);
const sharesUndelegated = (nationId: number, from: string, to: string, block: bigint, logIndex = 0) =>
  coreLog('SharesUndelegated', { nationId, from, to, amount: 1n }, block, logIndex);

/** What the client gets after decoding a `/policy` body: event name and nation-shaped args. */
function decodedPolicy(body: Record<string, unknown>) {
  return (body.logs as { topics: Hex[]; data: Hex; blockNumber: string }[]).map((log) => {
    const decoded = decodeEventLog({ abi: coreAbi as Abi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
    return { eventName: decoded.eventName, block: log.blockNumber, args: decoded.args };
  });
}

describe('/policy nation-id topics (U22.6)', () => {
  it('reads the nation ids every policy event indexes, from its topics', () => {
    const cases: [ReturnType<typeof coreLog>, number[]][] = [
      [warDeclared(4, 2, 101n), [2, 4]],
      [allianceProposed(7, 3, 101n), [3, 7]],
      [allianceFormed(9, 1, 101n), [1, 9]],
      [renamed(5, 101n), [5]],
      [modeChanged(6, 101n), [6]],
      [leaderChanged(8, ALICE, BOB, 101n), [8]],
      [sharesDelegated(194, ALICE, BOB, 101n), [194]],
      [sharesUndelegated(65_535, ALICE, BOB, 101n), [65_535]],
    ];
    // One case per cataloged policy event, so a new one cannot go untested.
    expect(cases.map(([log]) => stored(log).eventName).sort()).toEqual(
      [...catalogEvents('policy')].sort(),
    );
    for (const [log, nations] of cases) expect(policyNations(stored(log))).toEqual(nations);
  });

  it('matches by topic alone: no data, no decoding', () => {
    const { topics } = warDeclared(4, 2, 101n);
    expect(policyNations({ eventName: 'WarDeclared', topics })).toEqual([2, 4]);
    // A truncated log yields what its topics prove and nothing more.
    expect(policyNations({ eventName: 'WarDeclared', topics: topics.slice(0, 2) })).toEqual([4]);
    expect(policyNations({ eventName: 'TroopsRecruited', topics })).toEqual([]);
  });

  it('takes topic positions from the ABI', () => {
    const topics = policyNationTopics();
    expect([...topics.keys()].sort()).toEqual([...catalogEvents('policy')].sort());
    expect(topics.get('WarDeclared')).toEqual([1, 2]);
    expect(topics.get('AllianceFormed')).toEqual([1, 2]);
    expect(topics.get('LeaderChanged')).toEqual([1]);
    expect(topics.get('SharesUndelegated')).toEqual([1]);
  });

  it('refuses a cataloged policy event with no known nation-id topic', () => {
    const policy = catalogEvents('policy');
    expect(() => policyNationTopics(coreAbi as Abi, [...policy, 'ParamChanged'])).toThrow(
      /ParamChanged has no known nation-id topic/,
    );

    // A brand-new policy event, synced into both the ABI and the catalog.
    const treaty: AbiEvent = {
      type: 'event',
      name: 'TreatySigned',
      inputs: [{ name: 'treatyId', type: 'uint256', indexed: true }],
      anonymous: false,
    };
    expect(() =>
      policyNationTopics([...(coreAbi as Abi), treaty], [...policy, 'TreatySigned']),
    ).toThrow(/TreatySigned has no known nation-id topic/);
  });

  it('refuses an ABI that stopped indexing a listed nation arg, or a table the catalog lost', () => {
    const unindexed = (coreAbi as Abi).map((item) =>
      item.type === 'event' && item.name === 'WarDeclared'
        ? {
            ...item,
            inputs: item.inputs.map((input) =>
              input.name === 'onNation' ? { ...input, indexed: false } : input,
            ),
          }
        : item,
    );
    expect(() => policyNationTopics(unindexed)).toThrow(/WarDeclared\.onNation/);

    const policy = catalogEvents('policy').filter((name) => name !== 'SharesUndelegated');
    expect(() => policyNationTopics(coreAbi as Abi, policy)).toThrow(
      /SharesUndelegated, which is not a §16 catalog policy event/,
    );
    expect(Object.keys(POLICY_NATION_ARGS)).toContain('SharesUndelegated');
  });
});

describe('/policy route (U22.6)', () => {
  it('returns the oldest WarDeclared for both nations past the 200-row policy ring', async () => {
    const store = openStore(':memory:', 100n);
    const filler = FEED_BUFFER_LIMITS.policy + 50;
    const logs = [warDeclared(1, 2, 101n)];
    for (let i = 0; i < filler; i++) logs.push(renamed(1, BigInt(102 + i)));
    commitAll(store, logs, BigInt(102 + filler));

    // The ring the UI folds today has already lost it.
    const snapshot = await request(store, '/snapshot');
    expect(snapshot.body.logs).toHaveLength(FEED_BUFFER_LIMITS.policy);
    expect(decodedPolicy(snapshot.body).some((log) => log.eventName === 'WarDeclared')).toBe(false);

    const first = decodedPolicy((await request(store, '/policy?nation=1')).body);
    // No cap: every one of nation 1's policy logs, oldest first.
    expect(first).toHaveLength(filler + 1);
    expect(first[0]).toEqual({
      eventName: 'WarDeclared',
      block: '101',
      args: { byNation: 1, onNation: 2, expiresAt: 9n },
    });
    expect(first.map((log) => Number(log.block))).toEqual(
      [...first.map((log) => Number(log.block))].sort((a, b) => a - b),
    );

    const second = decodedPolicy((await request(store, '/policy?nation=2')).body);
    expect(second.map((log) => log.eventName)).toEqual(['WarDeclared']);
    expect((await request(store, '/policy?nation=3')).body.logs).toEqual([]);
    store.close();
  });

  it('serves AllianceFormed(a, b) to both a and b', async () => {
    const store = openStore(':memory:', 100n);
    commitAll(store, [allianceProposed(4, 6, 101n), allianceFormed(4, 6, 102n)], 103n);

    for (const nation of [4, 6]) {
      const logs = decodedPolicy((await request(store, `/policy?nation=${nation}`)).body);
      expect(logs.map((log) => log.eventName)).toEqual(['AllianceProposed', 'AllianceFormed']);
    }
    expect((await request(store, '/policy?nation=5')).body.logs).toEqual([]);
    store.close();
  });

  it('serves the current round only: a RoundReset floors the result', async () => {
    const store = openStore(':memory:', 100n);
    commitAll(store, [warDeclared(1, 2, 101n), sharesDelegated(1, ALICE, BOB, 102n)], 103n);
    commitAll(store, [resetTo(2n, 105n), modeChanged(1, 106n)], 107n);

    const response = await request(store, '/policy?nation=1');
    expect(response.body.roundId).toBe('2');
    expect(decodedPolicy(response.body).map((log) => [log.eventName, log.block])).toEqual([
      ['ModeChanged', '106'],
    ]);
    expect((await request(store, '/policy?nation=2')).body.logs).toEqual([]);
    store.close();
  });

  it('drops rewound rows, so a new log at the same position is not misfiled', async () => {
    const store = openStore(':memory:', 100n);
    commitAll(store, [warDeclared(1, 2, 101n)], 102n);
    commitAll(store, [warDeclared(1, 3, 106n), renamed(1, 107n)], 108n);

    store.rewind(105n, { nextFrom: 105n, confirmedHash: hash(104) });
    const kept = await request(store, '/policy?nation=1');
    expect(decodedPolicy(kept.body).map((log) => log.block)).toEqual(['101']);
    expect((await request(store, '/policy?nation=3')).body.logs).toEqual([]);

    // The canonical chain has a different policy log at the rewound 106:0. A stale (1, 106, 0)
    // row would join to it and hand nation 5's mode change to nation 1.
    commitAll(store, [modeChanged(5, 106n)], 108n);
    expect(decodedPolicy((await request(store, '/policy?nation=1')).body).map((log) => log.block)).toEqual([
      '101',
    ]);
    expect(decodedPolicy((await request(store, '/policy?nation=5')).body).map((log) => log.eventName)).toEqual([
      'ModeChanged',
    ]);
    store.close();
  });

  it('carries the wire envelope and raw logs in /snapshot\'s shape', async () => {
    const store = openStore(':memory:', 100n);
    commitAll(store, [recruitedAt(ALICE, 1, 101n), warDeclared(1, 2, 102n)], 104n);

    const response = await request(store, '/policy?nation=2');
    const snapshot = await request(store, '/snapshot');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      chainId: CHAIN,
      roundId: '1',
      asOfBlock: '103',
      // Byte for byte the entry /snapshot serves for the same log.
      logs: [(snapshot.body.logs as unknown[])[1]],
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBe('https://play.example');
    store.close();
  });

  it('answers 400 for a missing or malformed nation, and an empty list past the last nation', async () => {
    const store = openStore(':memory:', 100n);
    commitAll(store, [warDeclared(1, 2, 101n)], 102n);

    for (const path of [
      '/policy',
      '/policy?nation=',
      '/policy?nation=abc',
      '/policy?nation=0',
      '/policy?nation=-1',
      '/policy?nation=1.5',
      '/policy?nation=65536',
    ]) {
      const response = await request(store, path);
      expect(response.status, path).toBe(400);
      expect(response.body).toEqual({ error: 'nation must be a nation id' });
    }
    // Bounded by the uint16 id format: no eth_call for nationCountTotal (U22.6 decision).
    const beyond = await request(store, '/policy?nation=65535');
    expect(beyond.status).toBe(200);
    expect(beyond.body.logs).toEqual([]);
    store.close();
  });

  it('answers 503 { catchingUp: true } while ingest is behind', async () => {
    const store = openStore(':memory:', 100n);
    commitAll(store, [warDeclared(1, 2, 101n)], 102n);

    const response = await request(store, '/policy?nation=1', { ...caughtUp, catchingUp: true });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ catchingUp: true });
    store.close();
  });

  it('backfills the index from stored events on boot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schizo-indexer-'));
    const dbPath = join(dir, 'indexer.db');
    try {
      const before = openStore(dbPath, 100n);
      commitAll(
        before,
        [warDeclared(1, 2, 101n), resetTo(2n, 103n), allianceFormed(2, 3, 104n), renamed(3, 105n)],
        106n,
      );
      before.close();

      // Turn it into a database from before U22.6: events, no policy index.
      const raw = new Database(dbPath);
      raw.exec("DROP TABLE policy_nations; DELETE FROM meta WHERE key = 'policy_index'");
      raw.close();

      const store = openStore(dbPath, 100n);
      expect(decodedPolicy((await request(store, '/policy?nation=3')).body).map((log) => log.eventName)).toEqual([
        'AllianceFormed',
        'NationRenamed',
      ]);
      expect(decodedPolicy((await request(store, '/policy?nation=2')).body).map((log) => log.eventName)).toEqual([
        'AllianceFormed',
      ]);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is kept current by ingest with no eth_call', async () => {
    const store = openStore(':memory:', 100n);
    const chain = fakeChain([warDeclared(1, 2, 101n), allianceProposed(2, 1, 105n)], 110n);
    const ethCalls: string[] = [];
    const ingestor = createIngestor(config, store, {
      ...chain.client,
      readContract: async () => ethCalls.push('readContract'),
      multicall: async () => ethCalls.push('multicall'),
      call: async () => ethCalls.push('call'),
    } as never);

    await ingestor.tick();

    expect(ingestor.status().catchingUp).toBe(false);
    expect(ethCalls).toEqual([]);
    const response = await respond(createHttpHandler(config, store, ingestor), '/policy?nation=1');
    expect(response.body.asOfBlock).toBe('110');
    expect(decodedPolicy(response.body).map((log) => log.eventName)).toEqual([
      'WarDeclared',
      'AllianceProposed',
    ]);
    store.close();
  });
});
