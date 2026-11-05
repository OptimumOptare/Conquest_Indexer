/**
 * §16 event catalog — the same six buckets (D46 added `market`, U25.1 `infection`) and the same limits the UI's
 * `ui/src/chain/feedEvents.ts` uses.
 *
 * This file is a deliberate copy of a UI module, and that is a drift risk worth naming: if the
 * data model gains an event and only one side learns about it, the indexer silently stops
 * serving it (or serves it uncategorized). The ABIs are copied too, from the same committed
 * source. Both are refreshed by `npm run sync:abis` against a checkout of the game repo — see
 * README "Keeping in sync with the game repo".
 *
 * Categorization only decides which ring an event lands in. Decoding is still the *client's*
 * job: this service ships raw logs on the wire, so an event this file miscategorizes shows up
 * in the wrong feed tab but can never be misread as different data.
 */

export type FeedCategory =
  | 'activity'
  | 'news'
  | 'policy'
  | 'meta'
  | 'market'
  | 'infection';

/** UD11 ring-buffer caps — how much history `/snapshot` serves per category. */
export const FEED_BUFFER_LIMITS: Record<FeedCategory, number> = {
  activity: 500,
  news: 200,
  policy: 200,
  meta: 200,
  market: 200,
  // One tick can stamp hundreds of provinces; 1,000 keeps the last few ticks' lists whole.
  infection: 1_000,
};

const ACTIVITY = new Set([
  'TroopsRecruited',
  'TroopsMoved',
  'TroopsBurned',
  'AttackResolved',
  'ProvinceConquered',
  'GoldPurchased',
  'GoldHarvested',
  'FaucetClaimed',
  'FaucetCollectionSet',
]);

/**
 * §16 News, plus one D16 ops event: `TickAdvanced` is the infection ticker (T68). It sits here
 * rather than in meta because meta has no reader-facing surface (§6.1 has three tabs). The UI
 * lists the provinces its pass stamped under its row (U25.1); the stamps are in `infection`.
 */
const NEWS = new Set([
  'PathChosen',
  'WeaponResearched',
  'WeaponPurchased',
  'WeaponDeployed',
  'TickAdvanced',
  'NecromancyResolved',
  'NationEliminated',
]);

const POLICY = new Set([
  'WarDeclared',
  'AllianceProposed',
  'AllianceFormed',
  'NationRenamed',
  'ModeChanged',
  'LeaderChanged',
  'SharesDelegated',
  'SharesUndelegated',
]);

const META = new Set([
  'PlayerRegistered',
  'PfpSet',
  'NicknameSet',
  'AchievementUnlocked',
  'DelegateApproved',
  'DelegateRevoked',
  'RoundReset',
  'GameStarted',
  'GameEnded',
  'JackpotPaid',
  'GoldAirdropped',
  'CPAirdropped',
  'ResourcesAirdropped',
  'DevWithdrawn',
  'EmergencyWithdrawn',
  'ParamChanged',
  'PhaseChanged',
  'ProvinceDestroyed',
  'ProvinceRevived',
  'ProvincePowerSet',
  // D45 — the treasury a capital capture moved; the UI's conquest window reads it (U23.1).
  'TreasuryCaptured',
]);

/**
 * D46 (F7.1) — the Black Market trade history. `OfferTaken` names both nations, the goods and the
 * payment, so one log is one row. Opens, cancels and voids are not history and stay uncataloged.
 */
const MARKET = new Set(['OfferTaken']);

/**
 * U25.1 — §16 News's `InfectionSpread`, in a bucket of its own. A tick pass stamps hundreds of
 * provinces; in News they filled the whole 200-row `/snapshot` page and pushed every other story
 * out. The UI lists them under their `TickAdvanced` row.
 */
const INFECTION = new Set(['InfectionSpread']);

const CATEGORY_EVENTS: Record<FeedCategory, ReadonlySet<string>> = {
  activity: ACTIVITY,
  news: NEWS,
  policy: POLICY,
  meta: META,
  market: MARKET,
  infection: INFECTION,
};

/** Every cataloged event in `category`. `/policy` checks its nation-id table against this (U22.6). */
export function catalogEvents(category: FeedCategory): readonly string[] {
  return [...CATEGORY_EVENTS[category]];
}

export function categorizeEvent(eventName: string): FeedCategory | null {
  if (ACTIVITY.has(eventName)) return 'activity';
  if (NEWS.has(eventName)) return 'news';
  if (POLICY.has(eventName)) return 'policy';
  if (META.has(eventName)) return 'meta';
  if (MARKET.has(eventName)) return 'market';
  if (INFECTION.has(eventName)) return 'infection';
  return null;
}
