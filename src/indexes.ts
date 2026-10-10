/**
 * UD24 event-derived indexes (U22.1): every registered player, and every (player, province) pair
 * of the current round.
 *
 * Both are folds over this service's own `events` table. No chain reads and no game math: a log
 * either proves a fact or it is skipped. The one exception is the necromancy credit (Q-U19),
 * whose (leader, capital) the log does not carry. The ingest loop resolves that from
 * `SchizoLens.getNations` at the log's block and hands the pair in (see `ingest.ts`).
 *
 * Decoding here only reads index keys out of a log. The wire format of `/snapshot` and `/events`
 * is still raw logs, decoded by the client.
 */

import { decodeEventLog, type Abi, type Hex } from 'viem';
import schizoCoreAbi from './abis/SchizoCore.json' with { type: 'json' };

const CORE_ABI = schizoCoreAbi as Abi;

/** One "this player has touched this province" observation. Address lowercased. */
export type PresencePair = {
  readonly player: string;
  readonly province: number;
};

/** What a stored log needs to carry for the indexes to be derived from it. */
export type IndexableLog = {
  readonly eventName: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: bigint;
  readonly logIndex: number;
};

/** A `NecromancyResolved` that credited troops, still to be placed via the lens. */
export type NecromancyRequest = {
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly nationId: number;
};

/** (leader, capital) per crediting `NecromancyResolved`, keyed by `logKey`. */
export type NecromancyCredits = ReadonlyMap<string, PresencePair>;

export type IndexFacts = {
  /** `PlayerRegistered` → the player. */
  readonly registered: string | null;
  /** Pairs the log proves, per `troopPresencePairs`. */
  readonly pairs: readonly PresencePair[];
  /** `RoundReset` opens a new round: every later pair belongs to it. */
  readonly roundReset: boolean;
};

/** The events any index reads. Everything else is skipped without decoding. */
export const INDEX_EVENT_NAMES: readonly string[] = [
  'PlayerRegistered',
  'TroopsRecruited',
  'TroopsBurned',
  'TroopsMoved',
  'AttackResolved',
  'RoundReset',
  'NecromancyResolved',
];

const INDEX_EVENTS = new Set(INDEX_EVENT_NAMES);

const NO_FACTS: IndexFacts = { registered: null, pairs: [], roundReset: false };

export function logKey(blockNumber: bigint | number, logIndex: number): string {
  return `${blockNumber.toString()}:${logIndex}`;
}

function asAddress(value: unknown): string | null {
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value.trim())) {
    return value.trim().toLowerCase();
  }
  return null;
}

function asPositiveId(value: unknown): number | null {
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  return null;
}

function pair(
  out: PresencePair[],
  player: string | null,
  province: number | null,
): void {
  if (player === null || province === null) return;
  out.push({ player, province });
}

/**
 * §16 troop-presence extraction, ported from the UI's `chain/troopPresence.ts`. The two must
 * agree exactly: the UI merges these pairs into the ones it derives itself (U22.2).
 *
 * `units` is `province → epoch → player → uint256` with no player index, so no view can
 * enumerate who is standing in a province: the candidate set has to come from the events that put
 * them there. Every unit in a province arrived through `TroopsRecruited`, `TroopsMoved` or a
 * conquering `AttackResolved`, so the pairs below are a **superset** of the real garrison.
 * `effectiveTroops` is what turns that superset into the answer — a stale candidate reads 0
 * whether they moved out, burned, or were wiped by the `factorEpoch` bump on conquest, so the
 * index never has to model any of those.
 *
 * The one gap is the necromancy credit, which places troops for the nation's leader at its
 * capital and emits no troop event. The indexer closes it from `NecromancyResolved` plus a lens
 * read (Q-U19); see `necromancyRequest`.
 *
 * Non-troop events yield nothing; malformed args are skipped, never guessed at.
 */
export function troopPresencePairs(
  eventName: string,
  args: Readonly<Record<string, unknown>>,
): readonly PresencePair[] {
  const out: PresencePair[] = [];

  switch (eventName) {
    case 'TroopsRecruited':
    case 'TroopsBurned':
      pair(out, asAddress(args.player), asPositiveId(args.province));
      break;
    case 'TroopsMoved': {
      const player = asAddress(args.player);
      pair(out, player, asPositiveId(args.fromProvince));
      pair(out, player, asPositiveId(args.toProvince));
      break;
    }
    case 'AttackResolved': {
      const attacker = asAddress(args.attacker);
      pair(out, attacker, asPositiveId(args.fromProvince));
      pair(out, attacker, asPositiveId(args.toProvince));
      break;
    }
    default:
      break;
  }

  return out;
}

/** Decoded args of an index event, or null for any other event or an undecodable log. */
function indexArgs(log: IndexableLog): Record<string, unknown> | null {
  if (!INDEX_EVENTS.has(log.eventName) || log.topics.length === 0) return null;
  try {
    const decoded = decodeEventLog({
      abi: CORE_ABI,
      data: log.data as Hex,
      topics: log.topics as [Hex, ...Hex[]],
      strict: false,
    }) as { eventName: string; args: unknown };
    if (decoded.eventName !== log.eventName) return null;
    if (decoded.args === null || typeof decoded.args !== 'object') return null;
    return decoded.args as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Everything one log contributes to `/players` and `/presence`, except the necromancy pair. */
export function indexFacts(log: IndexableLog): IndexFacts {
  if (log.eventName === 'RoundReset') {
    return { ...NO_FACTS, roundReset: true };
  }
  const args = indexArgs(log);
  if (args === null) return NO_FACTS;
  if (log.eventName === 'PlayerRegistered') {
    return { ...NO_FACTS, registered: asAddress(args.player) };
  }
  return { ...NO_FACTS, pairs: troopPresencePairs(log.eventName, args) };
}

/**
 * A `NecromancyResolved` that put troops on the map: `troopsRevived > 0` and not forfeited.
 * The pair it implies is (leader, capital) of `nationId` at that block, which only the lens knows.
 */
export function necromancyRequest(log: IndexableLog): NecromancyRequest | null {
  if (log.eventName !== 'NecromancyResolved') return null;
  const args = indexArgs(log);
  if (args === null) return null;
  const nationId = asPositiveId(args.nationId);
  const revived = args.troopsRevived;
  if (nationId === null || typeof revived !== 'bigint' || revived <= 0n) return null;
  if (args.forfeited !== false) return null;
  return { blockNumber: log.blockNumber, logIndex: log.logIndex, nationId };
}
