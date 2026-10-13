/**
 * UD24 cached chain reads (U22.3): `effectiveTroops(province, player)` for every current-round
 * (player, province) pair in `presence`, served by `GET /positions`.
 *
 * **No troop math here (UD24 rule 1).** Every number is the return value of
 * `SchizoCore.effectiveTroops` read with `eth_call` at a stated block. This module only decides
 * *when* to re-read. The view reads three fields — `units`, `troopFactorRaw`, `factorEpoch` — and
 * the contract writes them only inside a transaction that also logs the province it touched:
 *
 * | Writer (CombatLib)                         | Log that names the province               |
 * |--------------------------------------------|-------------------------------------------|
 * | `recruit` → `addUnits`                     | `TroopsRecruited.province`                |
 * | `move` → remove + add                      | `TroopsMoved` from and to                 |
 * | `burn` → `removeUnits`                     | `TroopsBurned.province`                   |
 * | `attack` → wipe / `scaleFactorTo` / units  | `AttackResolved` from and to (+ `ProvinceConquered`) |
 * | `destroyProvince` → `wipeFactorEpoch`      | `ProvinceDestroyed.province`              |
 * | `applyNuke` → wipe target, `cutFactor` adj | `WeaponDeployed.target`, **plus its neighbours** |
 * | `creditNecromancy` → `addUnits` at capital | `NecromancyResolved` → that nation's capital |
 * | `advanceTick` decay fold over the infected | `TickAdvanced` with `folded > 0` → every province with an `InfectionSpread` this round |
 * | `pokeProvince` decay fold                  | only ever runs right before one of the writers above |
 *
 * After each ingest batch the provinces those logs name are dirty, and every pair in them is
 * re-read at the new head. Nothing else has been written since it was last read, so the whole
 * cache is `effectiveTroops` at that head, and that block is the payload's `asOfBlock`. Anyone can
 * re-run the call there and compare.
 *
 * That argument is only as good as the table. So it is checked: every `positionsSweepMs` the
 * cache re-reads every pair and counts values that moved in provinces no trigger touched. Any
 * nonzero count is a missing trigger. It is logged as a warning and counted on `/health`, never
 * silently absorbed. The sweep's values replace the cache either way, so a missed trigger cannot
 * strand a value for longer than one interval.
 *
 * `ProvinceRevived` and `InfectionSpread` change none of the three fields. They are re-read
 * anyway because the ticket lists them, and an extra re-read costs one call and changes nothing.
 *
 * Pairs come from `presence`, which no troop event can bypass. The one holder it cannot name is
 * the nuke remnant owner, `0x…dEaD`, which `applyNuke` credits with no troop event. Its troop is
 * absent here, and from the UI's own garrison list for the same reason.
 */

import type { Abi, AbiEvent, Address, PublicClient } from 'viem';
import schizoCoreAbi from './abis/SchizoCore.json' with { type: 'json' };
import { categorizeEvent } from './catalog.js';
import type { Config } from './config.js';
import type { Store } from './db.js';
import {
  asPositiveId,
  decodeCoreArgs,
  type IndexableLog,
  type NecromancyCredits,
  type PresencePair,
} from './indexes.js';

const CORE_ABI = schizoCoreAbi as Abi;

/** What one log says about whose `effectiveTroops` it may have changed. */
export type TroopTriggers = {
  /** Provinces the log names. */
  readonly provinces: readonly number[];
  /** Provinces whose neighbours are dirty too: a nuke cuts every adjacent factor. */
  readonly withNeighbors: readonly number[];
  /** `TickAdvanced` folded decay into every infected province's factor. */
  readonly infected: boolean;
  /**
   * Re-read every pair. `RoundReset` starts a round in which nobody holds anything, so nothing
   * cached carries over. A trigger event that will not decode is also re-read in full, because
   * over-refreshing is the safe answer.
   */
  readonly all: boolean;
};

const NO_TRIGGERS: TroopTriggers = {
  provinces: [],
  withNeighbors: [],
  infected: false,
  all: false,
};

/** Province-valued args of every trigger that names its provinces directly. */
const PROVINCE_ARGS: Readonly<Record<string, readonly string[]>> = {
  TroopsRecruited: ['province'],
  TroopsMoved: ['fromProvince', 'toProvince'],
  TroopsBurned: ['province'],
  AttackResolved: ['fromProvince', 'toProvince'],
  ProvinceConquered: ['province'],
  ProvinceDestroyed: ['province'],
  ProvinceRevived: ['province'],
  InfectionSpread: ['province'],
};

/**
 * Every event that can dirty a province, with the arg each one is read by. `NecromancyResolved`
 * is placed through the ingest loop's lens read (Q-U19), not by this table's decoder.
 */
export const TROOP_TRIGGER_ARGS: Readonly<Record<string, readonly string[]>> = {
  ...PROVINCE_ARGS,
  WeaponDeployed: ['target'],
  TickAdvanced: ['folded'],
  NecromancyResolved: ['nationId'],
  RoundReset: ['roundId'],
};

/**
 * Fail at boot, not in production, if an ABI sync renamed a trigger arg or the catalog dropped a
 * trigger event. Either would make a trigger silently never fire. The sweep would catch it, but
 * only up to five minutes late on every value.
 */
export function assertTriggerCatalog(abi: Abi = CORE_ABI): void {
  const events = new Map(
    abi
      .filter((item): item is AbiEvent => item.type === 'event')
      .map((item) => [item.name, item]),
  );
  for (const [eventName, args] of Object.entries(TROOP_TRIGGER_ARGS)) {
    if (categorizeEvent(eventName) === null) {
      throw new Error(`/positions trigger ${eventName} is not in the §16 catalog, so it is never stored`);
    }
    const event = events.get(eventName);
    for (const arg of args) {
      if (event === undefined || !event.inputs.some((input) => input.name === arg)) {
        throw new Error(`SchizoCore ABI has no ${eventName}.${arg}; that /positions trigger would never fire`);
      }
    }
  }
}

assertTriggerCatalog();

const TRIGGER_EVENTS = new Set(Object.keys(TROOP_TRIGGER_ARGS));

/** The provinces one log dirties. Pure: neighbours and the infected set are resolved later. */
export function troopTriggers(log: IndexableLog): TroopTriggers {
  if (!TRIGGER_EVENTS.has(log.eventName)) return NO_TRIGGERS;
  if (log.eventName === 'RoundReset') return { ...NO_TRIGGERS, all: true };
  // Placed from the lens read the ingest loop already made (see `observe`).
  if (log.eventName === 'NecromancyResolved') return NO_TRIGGERS;

  const args = decodeCoreArgs(log);
  if (args === null) return { ...NO_TRIGGERS, all: true };

  if (log.eventName === 'WeaponDeployed') {
    // `target` is a province for every province weapon, a nation id for Stock Market Crash and
    // ignored for Necromancy. Telling them apart would mean hardcoding weapon ids. Re-reading a
    // province that did not change is harmless, so every target counts.
    const target = asPositiveId(args.target);
    return target === null
      ? NO_TRIGGERS
      : { ...NO_TRIGGERS, provinces: [target], withNeighbors: [target] };
  }
  if (log.eventName === 'TickAdvanced') {
    const folded = args.folded;
    return typeof folded === 'bigint' && folded > 0n
      ? { ...NO_TRIGGERS, infected: true }
      : NO_TRIGGERS;
  }

  const provinces: number[] = [];
  for (const name of PROVINCE_ARGS[log.eventName] ?? []) {
    const province = asPositiveId(args[name]);
    if (province !== null) provinces.push(province);
  }
  return { ...NO_TRIGGERS, provinces };
}

/** province → player → troops, nonzero entries only. Players lowercased. */
type Values = Map<number, Map<string, bigint>>;

type Snapshot = {
  readonly roundId: bigint;
  asOfBlock: bigint;
  readonly values: Values;
};

export type SweepReport = {
  readonly block: bigint;
  /** Pairs re-read. */
  readonly pairs: number;
  /** Values that moved in provinces no trigger touched: nonzero is a missing trigger. */
  readonly changed: number;
  readonly at: number;
};

export type PositionsStatus = {
  readonly ready: boolean;
  readonly roundId: bigint | null;
  readonly asOfBlock: bigint | null;
  /** Nonzero (province, player) entries held. */
  readonly entries: number;
  /** Provinces waiting for a re-read, before neighbour and infection expansion. */
  readonly dirtyProvinces: number;
  readonly lastError: string | null;
  readonly lastSweep: SweepReport | null;
  /** Sum of `changed` over every sweep since boot. */
  readonly sweepChangedTotal: number;
};

/** `/positions` body minus the chain id: bigints as decimal strings. */
export type PositionsView = {
  readonly roundId: bigint;
  readonly asOfBlock: bigint;
  readonly positions: Record<string, Record<string, string>>;
};

/** Troops per player, summed over the provinces they hold, at `asOfBlock`. Players lowercased. */
export type PlayerTotals = {
  readonly roundId: bigint;
  readonly asOfBlock: bigint;
  readonly totals: ReadonlyMap<string, bigint>;
};

export type PositionsFilter = {
  readonly province?: number;
  /** Lowercased address. */
  readonly player?: string;
};

export type PositionsClient = Pick<PublicClient, 'multicall'>;

export type PositionsLogger = {
  readonly info: (line: string) => void;
  readonly warn: (line: string) => void;
};

export type PositionsOptions = {
  readonly now?: () => number;
  readonly logger?: PositionsLogger;
};

export type Positions = {
  /** Mark what a committed batch dirtied. `necromancy` is the batch's (leader, capital) credits. */
  observe: (logs: readonly IndexableLog[], necromancy: NecromancyCredits) => void;
  /** A reorg rewound the store. The cached block may be orphaned, so serve nothing until rebuilt. */
  invalidate: () => void;
  /**
   * Bring the cache to `head`, the block the store has ingested through. Call only when
   * ingest is at the tip. A failure leaves the previous snapshot served at its own block, with
   * the dirty set kept for the next call.
   */
  refresh: (head: bigint) => Promise<void>;
  /** The served body, or null until the first rebuild completes. */
  view: (filter?: PositionsFilter) => PositionsView | null;
  /** Each holder's troops summed over provinces, at the snapshot's block (U22.4's `troops`). */
  playerTotals: () => PlayerTotals | null;
  status: () => PositionsStatus;
};

/** Info to stdout, warnings to stderr. Shared with the `/leaderboard` cache. */
export const stdLogger: PositionsLogger = {
  info: (line) => process.stdout.write(`${line}\n`),
  warn: (line) => process.stderr.write(`${line}\n`),
};

/** Sample size of the per-value lines a sweep with changes prints. */
const SWEEP_REPORT_SAMPLE = 10;

/** `run` over `size`-item batches, `width` batches at a time, results in input order. */
export async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  width: number,
  run: (batch: readonly T[]) => Promise<readonly R[]>,
): Promise<R[]> {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  const out: R[] = [];
  for (let i = 0; i < batches.length; i += width) {
    const results = await Promise.all(batches.slice(i, i + width).map(run));
    for (const result of results) out.push(...result);
  }
  return out;
}

export function createPositions(
  config: Config,
  store: Store,
  client: PositionsClient,
  options: PositionsOptions = {},
): Positions {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? stdLogger;
  const coreAddress = config.contracts.core as Address;

  let snapshot: Snapshot | null = null;
  let rebuildAll = true;
  const dirty = new Set<number>();
  const nukeTargets = new Set<number>();
  let infectedDirty = false;
  let lastFullAt = 0;
  let lastError: string | null = null;
  let lastSweep: SweepReport | null = null;
  let sweepChangedTotal = 0;

  /**
   * Adjacency, loaded per nuke target on first use and kept for good. `setEdges` only runs in
   * round 1's Setup (`_requireRound1Setup`), and a weapon can only be deployed once the game is
   * Active, so a list read at any deploy is the final one.
   */
  const neighbors = new Map<number, readonly number[]>();

  function multicallOptions(block: bigint) {
    return {
      allowFailure: false as const,
      blockNumber: block,
      multicallAddress: config.multicall3,
      // Chunk by call count below, not by viem's default 1 KB of calldata.
      batchSize: 0,
    };
  }

  async function loadNeighbors(targets: Iterable<number>, block: bigint): Promise<void> {
    const missing = [...targets].filter((target) => !neighbors.has(target));
    if (missing.length === 0) return;
    const lists = await inBatches(
      missing,
      config.positionsBatchCalls,
      config.catchupConcurrency,
      async (batch) =>
        (await client.multicall({
          contracts: batch.map((province) => ({
            address: coreAddress,
            abi: CORE_ABI,
            functionName: 'neighborsOf',
            args: [province],
          })),
          ...multicallOptions(block),
        })) as readonly unknown[],
    );
    missing.forEach((target, i) => {
      const list = lists[i];
      if (!Array.isArray(list)) {
        throw new Error(`neighborsOf(${target}) returned ${String(list)}`);
      }
      neighbors.set(target, list.map((id) => Number(id)));
    });
  }

  /** `effectiveTroops` for each pair at `block`, nonzero only. Any failed call fails the read. */
  async function readPairs(pairs: readonly PresencePair[], block: bigint): Promise<Values> {
    const troops = await inBatches(
      pairs,
      config.positionsBatchCalls,
      config.catchupConcurrency,
      async (batch) =>
        (await client.multicall({
          contracts: batch.map((pair) => ({
            address: coreAddress,
            abi: CORE_ABI,
            functionName: 'effectiveTroops',
            args: [pair.province, pair.player],
          })),
          ...multicallOptions(block),
        })) as readonly unknown[],
    );
    const out: Values = new Map();
    pairs.forEach((pair, i) => {
      const value = troops[i];
      if (typeof value !== 'bigint') {
        throw new Error(
          `effectiveTroops(${pair.province}, ${pair.player}) returned ${String(value)}`,
        );
      }
      if (value === 0n) return;
      let holders = out.get(pair.province);
      if (holders === undefined) {
        holders = new Map();
        out.set(pair.province, holders);
      }
      holders.set(pair.player, value);
    });
    return out;
  }

  /** Dirty provinces with nuke neighbours and the infected set folded in. */
  async function touchedProvinces(head: bigint): Promise<Set<number>> {
    const out = new Set(dirty);
    await loadNeighbors(nukeTargets, head);
    for (const target of nukeTargets) {
      for (const neighbor of neighbors.get(target) ?? []) out.add(neighbor);
    }
    if (infectedDirty) {
      for (const province of store.infectedProvinces()) out.add(province);
    }
    return out;
  }

  function hasDirty(): boolean {
    return dirty.size > 0 || nukeTargets.size > 0 || infectedDirty;
  }

  function clearDirty(): void {
    dirty.clear();
    nukeTargets.clear();
    infectedDirty = false;
  }

  /** Values that differ between two reads, outside `skip`. */
  function diff(before: Values, after: Values, skip: ReadonlySet<number>) {
    const changes: { province: number; player: string; before: bigint; after: bigint }[] = [];
    for (const province of new Set([...before.keys(), ...after.keys()])) {
      if (skip.has(province)) continue;
      const was = before.get(province) ?? new Map<string, bigint>();
      const is = after.get(province) ?? new Map<string, bigint>();
      for (const player of new Set([...was.keys(), ...is.keys()])) {
        const a = was.get(player) ?? 0n;
        const b = is.get(player) ?? 0n;
        if (a !== b) changes.push({ province, player, before: a, after: b });
      }
    }
    return changes;
  }

  function report(head: bigint, pairs: number, changes: ReturnType<typeof diff>): void {
    lastSweep = { block: head, pairs, changed: changes.length, at: now() };
    sweepChangedTotal += changes.length;
    const line = `positions sweep at block ${head}: ${pairs} pairs re-read, ${changes.length} changed with no trigger`;
    if (changes.length === 0) {
      logger.info(line);
      return;
    }
    logger.warn(`${line}. A /positions trigger is missing.`);
    for (const change of changes.slice(0, SWEEP_REPORT_SAMPLE)) {
      logger.warn(
        `  province ${change.province} player ${change.player}: cached ${change.before}, chain ${change.after}`,
      );
    }
  }

  async function refresh(head: bigint): Promise<void> {
    try {
      const roundId = store.currentRound().roundId;
      const rebuild = snapshot === null || rebuildAll || snapshot.roundId !== roundId;
      const sweep = !rebuild && now() - lastFullAt >= config.positionsSweepMs;

      if (!rebuild && !sweep && !hasDirty()) {
        // Nothing written since the last read, so every value still holds at `head`.
        if (snapshot !== null) snapshot.asOfBlock = head;
        lastError = null;
        return;
      }

      if (rebuild || sweep) {
        const skip = sweep ? await touchedProvinces(head) : new Set<number>();
        const pairs = store.presencePairs();
        const values = await readPairs(pairs, head);
        if (sweep && snapshot !== null) report(head, pairs.length, diff(snapshot.values, values, skip));
        snapshot = { roundId, asOfBlock: head, values };
        lastFullAt = now();
        rebuildAll = false;
      } else if (snapshot !== null) {
        const touched = await touchedProvinces(head);
        const values = await readPairs(store.presencePairs(touched), head);
        // Synchronous from here: no request can see a half-applied refresh.
        for (const province of touched) snapshot.values.delete(province);
        for (const [province, holders] of values) snapshot.values.set(province, holders);
        snapshot.asOfBlock = head;
      }
      clearDirty();
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    observe(logs, necromancy) {
      for (const log of logs) {
        const triggers = troopTriggers(log);
        if (triggers.all) rebuildAll = true;
        for (const province of triggers.provinces) dirty.add(province);
        for (const target of triggers.withNeighbors) nukeTargets.add(target);
        if (triggers.infected) infectedDirty = true;
      }
      for (const credit of necromancy.values()) dirty.add(credit.province);
    },

    invalidate() {
      snapshot = null;
      rebuildAll = true;
      clearDirty();
    },

    refresh,

    view(filter = {}) {
      if (snapshot === null) return null;
      const provinces =
        filter.province === undefined
          ? [...snapshot.values.keys()].sort((a, b) => a - b)
          : [filter.province];
      const positions: Record<string, Record<string, string>> = {};
      for (const province of provinces) {
        const holders = snapshot.values.get(province);
        if (holders === undefined) continue;
        const entries = [...holders]
          .filter(([player]) => filter.player === undefined || player === filter.player)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        if (entries.length === 0) continue;
        positions[String(province)] = Object.fromEntries(
          entries.map(([player, troops]) => [player, troops.toString()]),
        );
      }
      return { roundId: snapshot.roundId, asOfBlock: snapshot.asOfBlock, positions };
    },

    playerTotals() {
      if (snapshot === null) return null;
      const totals = new Map<string, bigint>();
      for (const holders of snapshot.values.values()) {
        for (const [player, troops] of holders) {
          totals.set(player, (totals.get(player) ?? 0n) + troops);
        }
      }
      return { roundId: snapshot.roundId, asOfBlock: snapshot.asOfBlock, totals };
    },

    status() {
      let entries = 0;
      for (const holders of snapshot?.values.values() ?? []) entries += holders.size;
      return {
        ready: snapshot !== null,
        roundId: snapshot?.roundId ?? null,
        asOfBlock: snapshot?.asOfBlock ?? null,
        entries,
        // Every nuke target is in `dirty` as well, so this needs no union.
        dirtyProvinces: dirty.size,
        lastError,
        lastSweep,
        sweepChangedTotal,
      };
    },
  };
}
