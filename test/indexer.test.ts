import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Abi,
  type Hex,
} from 'viem';
import combatAbi from '../src/abis/Combat.json' with { type: 'json' };
import adminControllerAbi from '../src/abis/AdminController.json' with { type: 'json' };
import { categorizeEvent, FEED_BUFFER_LIMITS } from '../src/catalog.js';
import { CONTRACT_NAMES, type Config } from '../src/config.js';
import { openStore, type StoredLog } from '../src/db.js';
import { createHttpHandler } from '../src/server.js';
import { createIngestor, toStoredLog } from '../src/ingest.js';
import type { IngestStatus, Ingestor } from '../src/ingest.js';

const CHAIN = 10_143;
const PLAYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const COMBAT = '0xD08C80b9358cbEEB018Eb5863d2AfD22DA762310' as const;
const ADMIN = '0xD88E2085D19666707600480b37D53D8294c26bE7' as const;

const config: Config = {
  chainId: CHAIN,
  rpcHttp: 'http://rpc.invalid',
  contracts: {
    adminController: ADMIN,
    playerRegistry: '0x8Ed9A59A097683064E6421cC37230656C0ccA800',
    economy: '0xF03301044D2C5b90A16353e4D76b6cE8d6F1e629',
    combat: COMBAT,
    techWeapons: '0xF3b42B4754b6e79400Df77ADAF07030F34026819',
    diplomacy: '0xC443014E6f1d47Acb766e93A299997E5Ca4Cc8a1',
  },
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
    address: COMBAT,
    topics: encodeEventTopics({
      abi: combatAbi as Abi,
      eventName: 'TroopsRecruited',
      args: { player: PLAYER, province: 1 },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [100n, 90n, 10n],
    ),
    blockNumber,
    logIndex,
  });
}

function roundReset(blockNumber: bigint, logIndex: number) {
  return rpcLog({
    address: ADMIN,
    topics: encodeEventTopics({
      abi: adminControllerAbi as Abi,
      eventName: 'RoundReset',
      args: { roundId: 2n },
    }) as Hex[],
    data: '0x',
    blockNumber,
    logIndex,
  });
}

const byAddress = new Map(
  CONTRACT_NAMES.map((name) => [config.contracts[name].toLowerCase(), name]),
);

function stored(log: ReturnType<typeof recruited>): StoredLog {
  const result = toStoredLog(log, byAddress);
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
    const result = toStoredLog(recruited(101n, 0), byAddress);
    expect(result?.eventName).toBe('TroopsRecruited');
    expect(result?.category).toBe('activity');
  });

  it('drops a log from an address outside the address book', () => {
    const foreign = {
      ...recruited(101n, 0),
      address: '0x00000000000000000000000000000000deadbeef',
    };
    expect(toStoredLog(foreign, byAddress)).toBeNull();
  });

  it('drops an undecodable log', () => {
    const garbled = { ...recruited(101n, 0), topics: [hash(7)] as Hex[] };
    expect(toStoredLog(garbled, byAddress)).toBeNull();
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
