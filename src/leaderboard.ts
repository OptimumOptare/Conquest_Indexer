/**
 * UD24 cached chain reads (U22.4): one row per `/players` address with `nickname`,
 * `conquestPoints`, `gold`, `shares` and `troops`, served by `GET /leaderboard`.
 *
 * **No game math here (UD24 rule 1).** The first four are fields of
 * `SchizoLens.getPlayer(player, 1..nationCountTotal)`, read with `eth_call` at a stated block.
 * `shares` is the sum of its `holdings[].shares`, the same `sharesOf` values the UI's chain source
 * sums. `troops` is the sum of the player's `/positions` entries (U22.3). It is published only when
 * that cache holds the same block, so every field of every row holds at `asOfBlock`.
 *
 * This module only decides *when* to re-read a player. The rule is the ticket's: **a player is
 * dirty when an ingested log has their address in an address-typed arg**, taken from the ABI, not
 * from a list of events. That rule was checked against every contract writer of the four fields:
 *
 * | Writer                                          | Fields       | Log that names the player     |
 * |-------------------------------------------------|--------------|-------------------------------|
 * | `buyGold`                                       | gold, CP     | `GoldPurchased.player`        |
 * | `harvest` (also the recruit flush)              | gold, CP     | `GoldHarvested.player`        |
 * | `recruit` → `chargeRecruit`                     | gold, shares | `TroopsRecruited.player`      |
 * | `burn` → `creditBurnRefund`                     | gold         | `TroopsBurned.player`         |
 * | `attack` kill CP                                | CP           | `AttackResolved.attacker`     |
 * | `claimFaucet`                                   | gold, CP     | `FaucetClaimed.player`        |
 * | `airdropGold`, `airdropConquestPoints`          | gold, CP     | `GoldAirdropped` / `CPAirdropped` `.player` |
 * | `setNickname`, `adminSetNickname`               | nickname     | `NicknameSet.player`          |
 * | `setMode`, `rename`, `proposeAlliance`, `declareWar` → `spendGold` | gold | **none** |
 * | `deployWeapon` (Bio, Orbital, Nuke, Necromancy) → `grantCP` | CP | **none**              |
 * | `takeOffer` paid in gold (black market, D46)    | gold         | `OfferTaken.taker` (payer); seller's leader **none** |
 * | a new round (gold and shares are round-scoped)  | gold, shares | `RoundReset` → everyone       |
 *
 * The three "none" rows are leader actions. Their logs (`ModeChanged`, `NationRenamed`,
 * `AllianceProposed`, `WarDeclared`, `WeaponDeployed`) carry nation ids only, so the address rule
 * alone would miss every one of them and the sweep would report it each time. `OfferTaken` names
 * the paying leader (`taker`, an address arg) but credits the **seller's** leader, who it names
 * only as `sellerNation`; the gold goes to whoever led that nation at the take (spec 08). They are never
 * delegable (I10), so the payer is `msg.sender`, the nation's leader at that block. The cache
 * resolves it as `leaderOf(nation)` at the refresh head. That is the same address unless
 * leadership moved in between, and the only writer of `leader` (`claimLeadership`) logs
 * `LeaderChanged(oldLeader, newLeader)`, whose two address args are dirty in the same refresh.
 *
 * After each ingest batch at the tip, the dirty players are re-read at the head, plus any
 * registered player the cache has not read yet. Nothing else has been written since it was last
 * read, so the whole table holds at that head. As in U22.3, that argument is checked: every
 * `leaderboardSweepMs` the cache re-reads every player and logs how many rows moved with no
 * trigger. Nonzero is a missing trigger, reported as a warning and counted on `/health`.
 */

import {
  decodeFunctionResult,
  encodeFunctionData,
  multicall3Abi,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import schizoCoreAbi from './abis/SchizoCore.json' with { type: 'json' };
import schizoLensAbi from './abis/SchizoLens.json' with { type: 'json' };
import { categorizeEvent } from './catalog.js';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { asPositiveId, decodeCoreArgs, type IndexableLog } from './indexes.js';
import {
  inBatches,
  stdLogger,
  type Positions,
  type PositionsOptions,
} from './positions.js';

const CORE_ABI = schizoCoreAbi as Abi;
const LENS_ABI = schizoLensAbi as Abi;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Every `SchizoCore` event with an address-typed arg, and the names of those args. */
export function addressArgs(abi: Abi): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const item of abi) {
    if (item.type !== 'event') continue;
    const names = item.inputs
      .filter((input) => input.type === 'address' && input.name !== undefined)
      .map((input) => input.name as string);
    if (names.length > 0) out.set(item.name, names);
  }
  return out;
}

const ADDRESS_ARGS: ReadonlyMap<string, readonly string[]> = addressArgs(CORE_ABI);

/**
 * Leader actions that charge the leader's gold or grant them CP, with the arg that names the
 * nation. Their logs carry no address, so the address rule cannot see them (table above).
 */
export const LEADER_PAID_ARGS: Readonly<Record<string, string>> = {
  ModeChanged: 'nationId',
  NationRenamed: 'nationId',
  AllianceProposed: 'byNation',
  WarDeclared: 'byNation',
  WeaponDeployed: 'nationId',
  // D46 — the seller's leader is credited a gold payment. Resource-paid takes move no gold, and
  // re-reading the seller's leader then is a harmless extra read.
  OfferTaken: 'sellerNation',
};

/**
 * The address-typed arg the address rule depends on, per writer in the table above. Only a boot
 * check reads this: the rule itself comes from the ABI.
 */
const PLAYER_WRITER_ARGS: Readonly<Record<string, string>> = {
  GoldPurchased: 'player',
  GoldHarvested: 'player',
  TroopsRecruited: 'player',
  TroopsBurned: 'player',
  AttackResolved: 'attacker',
  FaucetClaimed: 'player',
  GoldAirdropped: 'player',
  CPAirdropped: 'player',
  NicknameSet: 'player',
  LeaderChanged: 'oldLeader',
  OfferTaken: 'taker',
};

/**
 * Fail at boot if an ABI sync or a catalog edit would make a trigger silently stop firing: a
 * writer's event that is no longer stored, a player arg that is no longer an address, or a leader
 * action that lost its nation arg. The sweep would catch any of them, but only up to five minutes
 * late on every row.
 */
export function assertLeaderboardTriggers(abi: Abi = CORE_ABI): void {
  const events = new Map(
    abi
      .filter((item): item is AbiEvent => item.type === 'event')
      .map((item) => [item.name, item]),
  );
  const checks: [string, string, (type: string) => boolean][] = [
    ...Object.entries(PLAYER_WRITER_ARGS).map(
      ([name, arg]): [string, string, (type: string) => boolean] => [
        name,
        arg,
        (type) => type === 'address',
      ],
    ),
    ...Object.entries(LEADER_PAID_ARGS).map(
      ([name, arg]): [string, string, (type: string) => boolean] => [
        name,
        arg,
        (type) => /^uint\d*$/.test(type),
      ],
    ),
    ['RoundReset', 'roundId', () => true],
  ];
  for (const [eventName, arg, typeOk] of checks) {
    if (categorizeEvent(eventName) === null) {
      throw new Error(`/leaderboard trigger ${eventName} is not in the §16 catalog, so it is never stored`);
    }
    const input = events.get(eventName)?.inputs.find((candidate) => candidate.name === arg);
    if (input === undefined || !typeOk(input.type)) {
      throw new Error(`SchizoCore ABI has no usable ${eventName}.${arg}; that /leaderboard trigger would never fire`);
    }
  }
}

assertLeaderboardTriggers();

/** What one log says about whose row it may have changed. */
export type PlayerTriggers = {
  /** Addresses in the log's address-typed args, lowercased. Non-players are ignored later. */
  readonly players: readonly string[];
  /** Nations whose leader paid or earned with no address in the log. */
  readonly nations: readonly number[];
  /**
   * Re-read everyone. `RoundReset` zeroes every round-scoped field. A log that will not decode is
   * also re-read in full, because over-refreshing is the safe answer.
   */
  readonly all: boolean;
};

const NO_TRIGGERS: PlayerTriggers = { players: [], nations: [], all: false };

function asAddress(value: unknown): string | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  const address = value.toLowerCase();
  return address === ZERO_ADDRESS ? null : address;
}

/** The players and leaders one log dirties. Pure: leaders are resolved at the refresh head. */
export function playerTriggers(log: IndexableLog): PlayerTriggers {
  if (log.eventName === 'RoundReset') return { ...NO_TRIGGERS, all: true };
  const names = ADDRESS_ARGS.get(log.eventName) ?? [];
  const nationArg = LEADER_PAID_ARGS[log.eventName];
  if (names.length === 0 && nationArg === undefined) return NO_TRIGGERS;

  const args = decodeCoreArgs(log);
  if (args === null) return { ...NO_TRIGGERS, all: true };

  const players: string[] = [];
  for (const name of names) {
    const player = asAddress(args[name]);
    if (player !== null) players.push(player);
  }
  const nation = nationArg === undefined ? null : asPositiveId(args[nationArg]);
  return { players, nations: nation === null ? [] : [nation], all: false };
}

/** The `getPlayer` fields a row serves. `troops` comes from `/positions` instead. */
type Metrics = {
  readonly nickname: string;
  readonly conquestPoints: bigint;
  readonly gold: bigint;
  readonly shares: bigint;
};

const METRIC_FIELDS = ['nickname', 'conquestPoints', 'gold', 'shares'] as const;

type Snapshot = {
  readonly roundId: bigint;
  readonly asOfBlock: bigint;
  /** `/players` at `asOfBlock`, ascending. Every one has an entry in `metrics`. */
  readonly players: readonly string[];
  readonly metrics: Map<string, Metrics>;
  readonly troops: ReadonlyMap<string, bigint>;
};

/** One `/leaderboard` row: bigints as decimal strings, address lowercased. */
export type LeaderboardRow = {
  readonly player: string;
  readonly nickname: string;
  readonly conquestPoints: string;
  readonly gold: string;
  readonly shares: string;
  readonly troops: string;
};

/** `/leaderboard` body minus the chain id. */
export type LeaderboardView = {
  readonly roundId: bigint;
  readonly asOfBlock: bigint;
  readonly rows: readonly LeaderboardRow[];
};

export type LeaderboardSweepReport = {
  readonly block: bigint;
  /** Players re-read. */
  readonly players: number;
  /** Rows that moved for players no trigger named: nonzero is a missing trigger. */
  readonly changed: number;
  readonly at: number;
};

export type LeaderboardStatus = {
  readonly ready: boolean;
  readonly roundId: bigint | null;
  readonly asOfBlock: bigint | null;
  readonly rows: number;
  readonly dirtyPlayers: number;
  readonly dirtyNations: number;
  readonly lastError: string | null;
  readonly lastSweep: LeaderboardSweepReport | null;
  /** Sum of `changed` over every sweep since boot. */
  readonly sweepChangedTotal: number;
};

/**
 * `call` because `getPlayer` needs an explicit gas limit, which viem's `multicall` cannot pass;
 * `multicall` for the small `nationCountTotal` / `leaderOf` read.
 */
export type LeaderboardClient = Pick<PublicClient, 'call' | 'multicall'>;

export type Leaderboard = {
  /** Mark what a committed batch dirtied. */
  observe: (logs: readonly IndexableLog[]) => void;
  /** A reorg rewound the store. The cached block may be orphaned, so serve nothing until rebuilt. */
  invalidate: () => void;
  /**
   * Bring the table to `head`. Call right after `positions.refresh(head)`: rows are published only
   * when `/positions` holds the same block. A failure, or `/positions` still behind, leaves the
   * previous table served at its own block, with the dirty set kept for the next call.
   */
  refresh: (head: bigint) => Promise<void>;
  /** The served body, or null until the first full read completes. */
  view: () => LeaderboardView | null;
  status: () => LeaderboardStatus;
};

/** Sample size of the per-row lines a sweep with changes prints. */
const SWEEP_REPORT_SAMPLE = 10;

function toMetrics(player: string, value: unknown): Metrics {
  const view = value as {
    nickname?: unknown;
    conquestPoints?: unknown;
    gold?: unknown;
    holdings?: unknown;
  };
  if (
    typeof view?.nickname !== 'string' ||
    typeof view.conquestPoints !== 'bigint' ||
    typeof view.gold !== 'bigint' ||
    !Array.isArray(view.holdings)
  ) {
    throw new Error(`getPlayer(${player}) returned an unexpected shape`);
  }
  let shares = 0n;
  for (const holding of view.holdings as { shares?: unknown }[]) {
    if (typeof holding?.shares !== 'bigint') {
      throw new Error(`getPlayer(${player}) returned a holding with no shares`);
    }
    shares += holding.shares;
  }
  return {
    nickname: view.nickname,
    conquestPoints: view.conquestPoints,
    gold: view.gold,
    shares,
  };
}

export function createLeaderboard(
  config: Config,
  store: Store,
  client: LeaderboardClient,
  positions: Positions,
  options: PositionsOptions = {},
): Leaderboard {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? stdLogger;
  const coreAddress = config.contracts.core as Address;
  const lensAddress = config.contracts.lens as Address;

  let snapshot: Snapshot | null = null;
  let rebuildAll = true;
  const dirtyPlayers = new Set<string>();
  const dirtyNations = new Set<number>();
  let lastFullAt = 0;
  let lastError: string | null = null;
  let lastSweep: LeaderboardSweepReport | null = null;
  let sweepChangedTotal = 0;

  /** `nationCountTotal`, and the leader of each nation in `nations`, at `block`. */
  async function readNations(
    nations: readonly number[],
    block: bigint,
  ): Promise<{ count: number; leaders: string[] }> {
    const results = (await client.multicall({
      contracts: [
        { address: coreAddress, abi: CORE_ABI, functionName: 'nationCountTotal', args: [] },
        ...nations.map((nationId) => ({
          address: coreAddress,
          abi: CORE_ABI,
          functionName: 'leaderOf',
          args: [nationId],
        })),
      ],
      allowFailure: false,
      blockNumber: block,
      multicallAddress: config.multicall3,
      batchSize: 0,
    })) as readonly unknown[];
    const [count, ...leaders] = results;
    if (typeof count !== 'number' && typeof count !== 'bigint') {
      throw new Error(`nationCountTotal returned ${String(count)}`);
    }
    const out: string[] = [];
    for (const leader of leaders) {
      const address = asAddress(leader);
      if (address !== null) out.push(address);
    }
    return { count: Number(count), leaders: out };
  }

  /**
   * `getPlayer` for each player at `block`, through `aggregate3` with `leaderboardCallGas`.
   *
   * The gas limit is not optional. On the public Monad RPC an `eth_call` with none gets a default
   * that a one- or two-`getPlayer` `aggregate3` overruns, and with `allowFailure: true` that would
   * come back as quiet failures (measured 2026-10-11). Here any failed sub-call reverts the batch.
   */
  async function readPlayers(
    players: readonly string[],
    nationCount: number,
    block: bigint,
  ): Promise<Map<string, Metrics>> {
    const nationIds = Array.from({ length: nationCount }, (_, i) => i + 1);
    const views = await inBatches(
      players,
      config.leaderboardBatchCalls,
      config.catchupConcurrency,
      async (batch) => {
        const data = encodeFunctionData({
          abi: multicall3Abi,
          functionName: 'aggregate3',
          args: [
            batch.map((player) => ({
              target: lensAddress,
              allowFailure: false,
              callData: encodeFunctionData({
                abi: LENS_ABI,
                functionName: 'getPlayer',
                args: [player as Address, nationIds],
              }),
            })),
          ],
        });
        const result = await client.call({
          to: config.multicall3,
          data,
          blockNumber: block,
          gas: config.leaderboardCallGas,
        });
        if (result.data === undefined) throw new Error('aggregate3 of getPlayer returned no data');
        const entries = decodeFunctionResult({
          abi: multicall3Abi,
          functionName: 'aggregate3',
          data: result.data,
        });
        if (entries.length !== batch.length) {
          throw new Error(`aggregate3 returned ${entries.length} results for ${batch.length} calls`);
        }
        return entries.map((entry, i) => {
          if (!entry.success) throw new Error(`getPlayer(${batch[i]}) failed`);
          return decodeFunctionResult({
            abi: LENS_ABI,
            functionName: 'getPlayer',
            data: entry.returnData as Hex,
          });
        });
      },
    );
    const out = new Map<string, Metrics>();
    players.forEach((player, i) => out.set(player, toMetrics(player, views[i])));
    return out;
  }

  function clearDirty(): void {
    dirtyPlayers.clear();
    dirtyNations.clear();
  }

  /** Rows whose fields differ between two reads, outside `skip`. */
  function diff(
    before: ReadonlyMap<string, Metrics>,
    after: ReadonlyMap<string, Metrics>,
    skip: ReadonlySet<string>,
  ) {
    const changes: { player: string; fields: string[] }[] = [];
    for (const [player, was] of before) {
      const is = after.get(player);
      if (skip.has(player) || is === undefined) continue;
      const fields = METRIC_FIELDS.filter((field) => was[field] !== is[field]).map(
        (field) => `${field} cached ${String(was[field])}, chain ${String(is[field])}`,
      );
      if (fields.length > 0) changes.push({ player, fields });
    }
    return changes;
  }

  function report(head: bigint, players: number, changes: ReturnType<typeof diff>): void {
    lastSweep = { block: head, players, changed: changes.length, at: now() };
    sweepChangedTotal += changes.length;
    const line = `leaderboard sweep at block ${head}: ${players} players re-read, ${changes.length} changed with no trigger`;
    if (changes.length === 0) {
      logger.info(line);
      return;
    }
    logger.warn(`${line}. A /leaderboard trigger is missing.`);
    for (const change of changes.slice(0, SWEEP_REPORT_SAMPLE)) {
      logger.warn(`  player ${change.player}: ${change.fields.join('; ')}`);
    }
  }

  async function refresh(head: bigint): Promise<void> {
    try {
      const roundId = store.currentRound().roundId;
      const troops = positions.playerTotals();
      if (troops === null || troops.asOfBlock !== head || troops.roundId !== roundId) {
        // `troops` must hold at the same block as the rest of the row.
        lastError = `/positions has no read at block ${head} yet`;
        return;
      }

      const rebuild = snapshot === null || rebuildAll || snapshot.roundId !== roundId;
      const sweep = !rebuild && now() - lastFullAt >= config.leaderboardSweepMs;
      const full = rebuild || sweep;
      const players = store.players();
      const known = snapshot?.metrics;
      // Who a trigger named this refresh, plus anyone registered the cache has never read.
      const named = new Set(dirtyPlayers);
      for (const player of players) if (known?.has(player) !== true) named.add(player);

      let values = new Map<string, Metrics>();
      let read = 0;
      const work = full || dirtyNations.size > 0 || players.some((player) => named.has(player));
      if (players.length > 0 && work) {
        const nations = await readNations([...dirtyNations], head);
        for (const leader of nations.leaders) named.add(leader);
        const toRead = full ? players : players.filter((player) => named.has(player));
        if (toRead.length > 0) values = await readPlayers(toRead, nations.count, head);
        read = toRead.length;
      }

      // Synchronous from here: no request can see a half-applied refresh.
      let metrics: Map<string, Metrics>;
      if (full) {
        if (sweep && snapshot !== null) report(head, read, diff(snapshot.metrics, values, named));
        metrics = values;
        lastFullAt = now();
        rebuildAll = false;
      } else {
        metrics = snapshot?.metrics ?? new Map();
        for (const [player, value] of values) metrics.set(player, value);
      }
      snapshot = { roundId, asOfBlock: head, players, metrics, troops: troops.totals };
      clearDirty();
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    observe(logs) {
      for (const log of logs) {
        const triggers = playerTriggers(log);
        if (triggers.all) rebuildAll = true;
        for (const player of triggers.players) dirtyPlayers.add(player);
        for (const nation of triggers.nations) dirtyNations.add(nation);
      }
    },

    invalidate() {
      snapshot = null;
      rebuildAll = true;
      clearDirty();
    },

    refresh,

    view() {
      if (snapshot === null) return null;
      const { metrics, troops } = snapshot;
      const rows = snapshot.players.map((player) => {
        const row = metrics.get(player);
        if (row === undefined) throw new Error(`/leaderboard has no read for ${player}`);
        return {
          player,
          nickname: row.nickname,
          conquestPoints: row.conquestPoints.toString(),
          gold: row.gold.toString(),
          shares: row.shares.toString(),
          troops: (troops.get(player) ?? 0n).toString(),
        };
      });
      return { roundId: snapshot.roundId, asOfBlock: snapshot.asOfBlock, rows };
    },

    status() {
      return {
        ready: snapshot !== null,
        roundId: snapshot?.roundId ?? null,
        asOfBlock: snapshot?.asOfBlock ?? null,
        rows: snapshot?.players.length ?? 0,
        dirtyPlayers: dirtyPlayers.size,
        dirtyNations: dirtyNations.size,
        lastError,
        lastSweep,
        sweepChangedTotal,
      };
    },
  };
}
