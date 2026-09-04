/**
 * §16 event catalog — the same four buckets and the same limits the UI's
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

export type FeedCategory = 'activity' | 'news' | 'policy' | 'meta';

/** UD11 ring-buffer caps — how much history `/snapshot` serves per category. */
export const FEED_BUFFER_LIMITS: Record<FeedCategory, number> = {
  activity: 500,
  news: 200,
  policy: 200,
  meta: 200,
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
 * rather than in meta because meta has no reader-facing surface (§6.1 has three tabs), and it is
 * the summary row for the `InfectionSpread` stamps it shares a transaction with.
 */
const NEWS = new Set([
  'PathChosen',
  'WeaponResearched',
  'WeaponPurchased',
  'WeaponDeployed',
  'InfectionSpread',
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
]);

export function categorizeEvent(eventName: string): FeedCategory | null {
  if (ACTIVITY.has(eventName)) return 'activity';
  if (NEWS.has(eventName)) return 'news';
  if (POLICY.has(eventName)) return 'policy';
  if (META.has(eventName)) return 'meta';
  return null;
}
