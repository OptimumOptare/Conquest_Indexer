/**
 * UD24 event-derived index (U22.6): which nations each `policy` log is about, for
 * `GET /policy?nation=<id>`.
 *
 * The chain has no views for war expiry, alliance expiry, `_lastWarDeclaredAt`,
 * `_lastModeChangeAt` or pending proposals, so the UI rebuilds all of them from policy events.
 * `/snapshot` serves those from a 200-row ring, which truncates the round once it passes 200 policy
 * events. This index lets the route serve one nation's whole round instead.
 *
 * **Matching is by topic, with no decoding.** Every policy event indexes the nation ids it is
 * about, and an indexed `uint16` topic is the id itself, left-padded to 32 bytes. The table below
 * names those args, and the ABI gives their topic positions. The route still serves raw logs that
 * the client decodes, so it can withhold a log but never invent one (UD21). No chain reads.
 *
 * A policy event this table does not know would never be indexed, and `/policy` would silently
 * drop it. So the boot fails instead (`policyNationTopics`): every `policy` event in the §16
 * catalog must be listed here, and each listed arg must be an indexed `uint16` in the ABI.
 */

import type { Abi, AbiEvent } from 'viem';
import schizoCoreAbi from './abis/SchizoCore.json' with { type: 'json' };
import { catalogEvents } from './catalog.js';

const CORE_ABI = schizoCoreAbi as Abi;

/** The args that name a nation, per `policy` event. */
export const POLICY_NATION_ARGS: Readonly<Record<string, readonly string[]>> = {
  WarDeclared: ['byNation', 'onNation'],
  AllianceProposed: ['byNation', 'toNation'],
  AllianceFormed: ['a', 'b'],
  NationRenamed: ['nationId'],
  ModeChanged: ['nationId'],
  LeaderChanged: ['nationId'],
  SharesDelegated: ['nationId'],
  SharesUndelegated: ['nationId'],
};

/**
 * Topic positions of each policy event's nation ids (`topics[0]` is the signature). Throws when a
 * cataloged policy event has no entry in `POLICY_NATION_ARGS`, when an entry is not a cataloged
 * policy event, or when the ABI does not index a listed arg as a `uint16`.
 */
export function policyNationTopics(
  abi: Abi = CORE_ABI,
  policyEvents: readonly string[] = catalogEvents('policy'),
): Map<string, number[]> {
  const events = new Map(
    abi
      .filter((item): item is AbiEvent => item.type === 'event')
      .map((item) => [item.name, item]),
  );
  for (const eventName of Object.keys(POLICY_NATION_ARGS)) {
    if (!policyEvents.includes(eventName)) {
      throw new Error(`/policy lists ${eventName}, which is not a §16 catalog policy event`);
    }
  }

  const out = new Map<string, number[]>();
  for (const eventName of policyEvents) {
    const args = POLICY_NATION_ARGS[eventName];
    if (args === undefined || args.length === 0) {
      throw new Error(
        `policy event ${eventName} has no known nation-id topic, so /policy would never serve it`,
      );
    }
    const indexed = events.get(eventName)?.inputs.filter((input) => input.indexed === true) ?? [];
    out.set(
      eventName,
      args.map((arg) => {
        const position = indexed.findIndex((input) => input.name === arg);
        if (position < 0 || indexed[position]?.type !== 'uint16') {
          throw new Error(
            `SchizoCore ABI has no indexed uint16 ${eventName}.${arg}; /policy could not match it`,
          );
        }
        return position + 1;
      }),
    );
  }
  return out;
}

const NATION_TOPICS: ReadonlyMap<string, readonly number[]> = policyNationTopics();

/**
 * The nation ids a stored policy log is about, read straight from its topics. Ascending, no
 * duplicates. A topic that is missing or not a nation id is skipped, never guessed at.
 */
export function policyNations(log: {
  readonly eventName: string;
  readonly topics: readonly string[];
}): number[] {
  const out = new Set<number>();
  for (const position of NATION_TOPICS.get(log.eventName) ?? []) {
    const topic = log.topics[position];
    if (topic === undefined || !/^0x[0-9a-fA-F]{64}$/.test(topic)) continue;
    const id = BigInt(topic);
    if (id >= 1n && id <= 0xffffn) out.add(Number(id));
  }
  return [...out].sort((a, b) => a - b);
}
