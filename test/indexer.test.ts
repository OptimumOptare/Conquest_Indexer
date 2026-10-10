import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Abi,
  type AbiEvent,
  type Hex,
} from 'viem';
import coreAbi from '../src/abis/SchizoCore.json' with { type: 'json' };
import { categorizeEvent, FEED_BUFFER_LIMITS } from '../src/catalog.js';
import type { Config } from '../src/config.js';
import { openStore, type Store, type StoredLog } from '../src/db.js';
import { createHttpHandler } from '../src/server.js';
import { createIngestor, toStoredLog } from '../src/ingest.js';
import type { IngestStatus, Ingestor } from '../src/ingest.js';
import { troopPresencePairs } from '../src/indexes.js';

const CHAIN = 10_143;
const PLAYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const CORE = '0x37e46aB1b63CDCBc18a7C738Cc43e0c146C6873f' as const;
const LENS = '0x63449a654091e81c93DA574e29ddcFCc4E6FF65E' as const;

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
      nextFrom: 106n,
      confirmedHash: hash(105),
    });
    store.rewind(105n, { nextFrom: 105n, confirmedHash: hash(104) });

    expect(store.eventsSince(104n, 10).logs).toHaveLength(0);
    expect(store.reorgFrom(110n)).toBe(105n);
    // A client that never got past 104 was never told anything wrong.
    expect(store.reorgFrom(104n)).toBeNull();
    store.close();
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
  const ingestor = { status: () => status } as unknown as Ingestor;

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
  const handler = createHttpHandler(config, store, { status: () => status } as unknown as Ingestor);
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
