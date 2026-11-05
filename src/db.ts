/**
 * SQLite store. One append-only `events` table plus a cursor and a short reorg log, and three
 * small UD24 indexes folded from it (`players`, `presence`, `policy_nations`).
 *
 * Sizing: a round is tens of thousands of logs — megabytes. SQLite on a Railway volume is the
 * right tool; Postgres would only buy multi-instance writes, which this service does not want
 * (one ingest loop, one cursor).
 *
 * The indexes are written in the same transaction as the events they come from, and every row
 * keeps the block of the log that first proved it (`first_block`). That makes a reorg rewind a
 * plain `first_block >= n` delete: a row whose first proof survives the rewind is still true.
 * `policy_nations` has one row per log, so it rewinds by the log's own block.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { FEED_BUFFER_LIMITS, type FeedCategory } from './catalog.js';
import {
  INDEX_EVENT_NAMES,
  indexFacts,
  logKey,
  necromancyRequest,
  type IndexableLog,
  type NecromancyCredits,
  type NecromancyRequest,
  type PresencePair,
} from './indexes.js';
import { policyNations } from './policy.js';

/**
 * `SchizoCore`'s constructor opens round 1, and every later round is announced by a `RoundReset`
 * carrying its id. Before the first reset the round id is therefore this, not a game parameter.
 */
const FIRST_ROUND_ID = 1n;

/** Bump to force a rebuild of `players` / `presence` from `events` on the next boot. */
const INDEXES_VERSION = '1';

/**
 * Bump to force a rebuild of `policy_nations` from `events` on the next boot. That rebuild needs no
 * chain read, so unlike `INDEXES_VERSION` it runs inside `openStore`.
 */
const POLICY_INDEX_VERSION = '1';

export type StoredLog = {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly eventName: string;
  readonly category: FeedCategory;
};

type EventRow = {
  address: string;
  topics: string;
  data: string;
  block_number: string;
  block_hash: string;
  tx_hash: string;
  log_index: number;
  event_name: string;
  category: string;
  /** Integer mirror of `block_number`, for indexing and ordering. */
  block_num: number;
};

/** Columns every read returns, in one place so the two queries cannot drift. */
const EVENT_COLUMNS = `address, topics, data, block_number, block_hash, tx_hash,
            log_index, event_name, category, block_num`;

/** Wire shape — exactly what the client's `RawLog` parser expects. */
export type WireLog = {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
};

function toWire(row: EventRow): WireLog {
  return {
    address: row.address,
    topics: JSON.parse(row.topics) as string[],
    data: row.data,
    blockNumber: row.block_number,
    blockHash: row.block_hash,
    transactionHash: row.tx_hash,
    logIndex: row.log_index,
  };
}

export type Cursor = {
  /** Next block to fetch (inclusive). */
  readonly nextFrom: bigint;
  /** Hash of `nextFrom - 1`, or null at the very start. */
  readonly confirmedHash: string | null;
};

export type Store = ReturnType<typeof openStore>;

export function openStore(dbPath: string, startBlock: bigint) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      block_number TEXT    NOT NULL,
      log_index    INTEGER NOT NULL,
      address      TEXT    NOT NULL,
      topics       TEXT    NOT NULL,
      data         TEXT    NOT NULL,
      block_hash   TEXT    NOT NULL,
      tx_hash      TEXT    NOT NULL,
      event_name   TEXT    NOT NULL,
      category     TEXT    NOT NULL,
      block_num    INTEGER NOT NULL,
      PRIMARY KEY (block_num, log_index)
    );
    CREATE INDEX IF NOT EXISTS events_by_block
      ON events (block_num, log_index);
    CREATE INDEX IF NOT EXISTS events_by_category
      ON events (category, block_num DESC, log_index DESC);
    CREATE INDEX IF NOT EXISTS events_by_name
      ON events (event_name, block_num DESC);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- head_at is the head the rewind cut back from: only a client whose cursor sits in
    -- [block_num, head_at] can still hold a rewound log.
    CREATE TABLE IF NOT EXISTS reorgs (
      block_num INTEGER PRIMARY KEY,
      seen_at   INTEGER NOT NULL,
      head_at   INTEGER
    );

    -- Every address with a PlayerRegistered log, across all rounds. The Registry is never
    -- reset, so neither is this.
    CREATE TABLE IF NOT EXISTS players (
      player      TEXT    PRIMARY KEY,
      first_block INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS players_by_first_block
      ON players (first_block);

    -- Every (player, province) pair, per round. round_start is the block of the RoundReset that
    -- opened the round (0 for round 1), the same floor /snapshot uses.
    CREATE TABLE IF NOT EXISTS presence (
      round_start INTEGER NOT NULL,
      player      TEXT    NOT NULL,
      province    INTEGER NOT NULL,
      first_block INTEGER NOT NULL,
      PRIMARY KEY (round_start, player, province)
    );
    CREATE INDEX IF NOT EXISTS presence_by_first_block
      ON presence (first_block);
    -- /positions re-reads one province's pairs at a time (U22.3).
    CREATE INDEX IF NOT EXISTS presence_by_province
      ON presence (round_start, province);

    -- The nation ids each policy log carries in its topics (U22.6), one row per (log, nation).
    -- Keyed nation first, because /policy reads one nation's logs in chain order.
    CREATE TABLE IF NOT EXISTS policy_nations (
      block_num INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      nation_id INTEGER NOT NULL,
      PRIMARY KEY (nation_id, block_num, log_index)
    );
    CREATE INDEX IF NOT EXISTS policy_nations_by_block
      ON policy_nations (block_num);
  `);

  // Volumes created before head_at existed. Their rows keep a null head_at and are never
  // reported again: without it there is no telling which cursors predate the rewind, and
  // reporting them to every cursor above the block wiped clients' feeds on each poll.
  const reorgColumns = db.pragma('table_info(reorgs)') as { name: string }[];
  if (!reorgColumns.some((column) => column.name === 'head_at')) {
    db.exec('ALTER TABLE reorgs ADD COLUMN head_at INTEGER');
  }

  // U25.1 moved InfectionSpread out of news. Rows ingested before then keep their old category
  // unless re-filed here, and /snapshot would serve them as news again. A no-op once done.
  db.exec(
    "UPDATE events SET category = 'infection' " +
      "WHERE event_name = 'InfectionSpread' AND category <> 'infection'",
  );

  const getMeta = db.prepare<[string], { value: string }>(
    'SELECT value FROM meta WHERE key = ?',
  );
  const setMeta = db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );

  const insertEvent = db.prepare(
    `INSERT INTO events
       (block_number, log_index, address, topics, data, block_hash, tx_hash,
        event_name, category, block_num)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(block_num, log_index) DO NOTHING`,
  );

  // ON CONFLICT DO NOTHING keeps the earliest first_block, which is what a rewind keys on.
  const insertPlayer = db.prepare(
    `INSERT INTO players (player, first_block) VALUES (?, ?)
     ON CONFLICT(player) DO NOTHING`,
  );
  const insertPresence = db.prepare(
    `INSERT INTO presence (round_start, player, province, first_block) VALUES (?, ?, ?, ?)
     ON CONFLICT(round_start, player, province) DO NOTHING`,
  );

  const insertPolicyNation = db.prepare(
    `INSERT INTO policy_nations (block_num, log_index, nation_id) VALUES (?, ?, ?)
     ON CONFLICT(nation_id, block_num, log_index) DO NOTHING`,
  );

  type PolicyIndexable = Pick<
    StoredLog,
    'eventName' | 'category' | 'topics' | 'blockNumber' | 'logIndex'
  >;

  /** Index a stored log's nation ids, if it is a policy log (U22.6). */
  function indexPolicy(log: PolicyIndexable): void {
    if (log.category !== 'policy') return;
    for (const nation of policyNations(log)) {
      insertPolicyNation.run(Number(log.blockNumber), log.logIndex, nation);
    }
  }

  const latestRoundReset = db.prepare<[], { block_num: number }>(
    "SELECT MAX(block_num) AS block_num FROM events WHERE event_name = 'RoundReset'",
  );

  /**
   * Fold logs, in chain order, into `players` / `presence`. `roundStart` is the round the first
   * log belongs to; a `RoundReset` moves every later log into the new round. Returns the round
   * the fold ended in.
   */
  function foldIndexes(
    logs: Iterable<IndexableLog>,
    roundStart: number,
    necromancy: NecromancyCredits,
  ): number {
    let round = roundStart;
    for (const log of logs) {
      const block = Number(log.blockNumber);
      const facts = indexFacts(log);
      if (facts.roundReset) round = block;
      if (facts.registered !== null) insertPlayer.run(facts.registered, block);
      for (const found of facts.pairs) {
        insertPresence.run(round, found.player, found.province, block);
      }
      const credit = necromancy.get(logKey(log.blockNumber, log.logIndex));
      if (credit !== undefined) {
        insertPresence.run(round, credit.player, credit.province, block);
      }
    }
    return round;
  }

  const insertMany = db.transaction(
    (logs: readonly StoredLog[], cursor: Cursor, necromancy: NecromancyCredits) => {
      foldIndexes(logs, latestRoundReset.get()?.block_num ?? 0, necromancy);
      for (const log of logs) {
        insertEvent.run(
          log.blockNumber.toString(),
          log.logIndex,
          log.address,
          JSON.stringify(log.topics),
          log.data,
          log.blockHash,
          log.transactionHash,
          log.eventName,
          log.category,
          Number(log.blockNumber),
        );
        indexPolicy(log);
      }
      setMeta.run('next_from', cursor.nextFrom.toString());
      setMeta.run('confirmed_hash', cursor.confirmedHash ?? '');
    },
  );

  const deleteFrom = db.prepare('DELETE FROM events WHERE block_num >= ?');
  const deletePlayersFrom = db.prepare('DELETE FROM players WHERE first_block >= ?');
  const deletePresenceFrom = db.prepare('DELETE FROM presence WHERE first_block >= ?');
  const deletePolicyNationsFrom = db.prepare('DELETE FROM policy_nations WHERE block_num >= ?');
  const insertReorg = db.prepare(
    'INSERT INTO reorgs (block_num, seen_at, head_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(block_num) DO UPDATE SET seen_at = excluded.seen_at, ' +
      'head_at = MAX(COALESCE(head_at, 0), excluded.head_at)',
  );
  const pruneReorgs = db.prepare('DELETE FROM reorgs WHERE block_num < ?');

  const rewindTx = db.transaction((fromBlock: bigint, headAt: bigint, cursor: Cursor) => {
    deleteFrom.run(Number(fromBlock));
    deletePlayersFrom.run(Number(fromBlock));
    deletePresenceFrom.run(Number(fromBlock));
    deletePolicyNationsFrom.run(Number(fromBlock));
    insertReorg.run(Number(fromBlock), Date.now(), Number(headAt));
    pruneReorgs.run(Number(fromBlock) - 10_000);
    setMeta.run('next_from', cursor.nextFrom.toString());
    setMeta.run('confirmed_hash', cursor.confirmedHash ?? '');
  });

  const categoryPage = db.prepare<[string, number, number], EventRow>(
    `SELECT ${EVENT_COLUMNS}
       FROM events
      WHERE category = ? AND block_num >= ?
      ORDER BY block_num DESC, log_index DESC
      LIMIT ?`,
  );

  const sinceBlock = db.prepare<[number, number], EventRow>(
    `SELECT ${EVENT_COLUMNS}
       FROM events
      WHERE block_num > ?
      ORDER BY block_num ASC, log_index ASC
      LIMIT ?`,
  );

  // A cursor above head_at was handed out after the rewind, from the canonical chain.
  const reorgSince = db.prepare<[number, number], { block_num: number }>(
    'SELECT MIN(block_num) AS block_num FROM reorgs WHERE block_num <= ? AND head_at >= ?',
  );

  const countAll = db.prepare<[], { n: number }>(
    'SELECT COUNT(*) AS n FROM events',
  );

  type IndexRow = Pick<EventRow, 'topics' | 'data' | 'event_name' | 'block_num' | 'log_index'>;
  const toIndexable = (row: IndexRow): IndexableLog => ({
    eventName: row.event_name,
    topics: JSON.parse(row.topics) as string[],
    data: row.data,
    blockNumber: BigInt(row.block_num),
    logIndex: row.log_index,
  });

  const indexEventRows = db.prepare<string[], IndexRow>(
    `SELECT topics, data, event_name, block_num, log_index
       FROM events
      WHERE event_name IN (${INDEX_EVENT_NAMES.map(() => '?').join(', ')})
      ORDER BY block_num ASC, log_index ASC`,
  );

  const necromancyRows = db.prepare<[], IndexRow>(
    `SELECT topics, data, event_name, block_num, log_index
       FROM events
      WHERE event_name = 'NecromancyResolved'
      ORDER BY block_num ASC, log_index ASC`,
  );

  const latestRoundResetRow = db.prepare<[], { block_num: number; topics: string }>(
    `SELECT block_num, topics
       FROM events
      WHERE event_name = 'RoundReset'
      ORDER BY block_num DESC, log_index DESC
      LIMIT 1`,
  );

  const allPlayers = db.prepare<[], { player: string }>(
    'SELECT player FROM players ORDER BY player ASC',
  );

  const roundPresence = db.prepare<[number], { player: string; province: number }>(
    `SELECT player, province
       FROM presence
      WHERE round_start = ?
      ORDER BY player ASC, province ASC`,
  );

  const provincePresence = db.prepare<[number, number], { player: string }>(
    `SELECT player
       FROM presence
      WHERE round_start = ? AND province = ?
      ORDER BY player ASC`,
  );

  // One row per province: InfectionSpread's only topic is the province, so equal topics are
  // the same province.
  const infectionTopics = db.prepare<[number], { topics: string }>(
    `SELECT DISTINCT topics
       FROM events
      WHERE event_name = 'InfectionSpread' AND block_num >= ?`,
  );

  // USING merges the two tables' block_num / log_index, so EVENT_COLUMNS stays unqualified.
  const nationPolicy = db.prepare<[number, number], EventRow>(
    `SELECT ${EVENT_COLUMNS}
       FROM policy_nations
       JOIN events USING (block_num, log_index)
      WHERE nation_id = ? AND block_num >= ? AND category = 'policy'
      ORDER BY block_num ASC, log_index ASC`,
  );

  type PolicyRow = Pick<EventRow, 'topics' | 'event_name' | 'category' | 'block_num' | 'log_index'>;
  const policyEventRows = db.prepare<[], PolicyRow>(
    `SELECT topics, event_name, category, block_num, log_index
       FROM events
      WHERE category = 'policy'`,
  );

  const clearPlayers = db.prepare('DELETE FROM players');
  const clearPresence = db.prepare('DELETE FROM presence');
  const clearPolicyNations = db.prepare('DELETE FROM policy_nations');

  const rebuildTx = db.transaction((necromancy: NecromancyCredits) => {
    clearPlayers.run();
    clearPresence.run();
    foldIndexes(
      indexEventRows.all(...INDEX_EVENT_NAMES).map(toIndexable),
      0,
      necromancy,
    );
    setMeta.run('indexes', INDEXES_VERSION);
  });

  // An empty events table has nothing to fold, so its (empty) indexes are already current.
  // A table that predates the indexes is rebuilt on boot instead (`rebuildIndexes`).
  if (getMeta.get('indexes') === undefined && (countAll.get()?.n ?? 0) === 0) {
    setMeta.run('indexes', INDEXES_VERSION);
  }

  // `policy_nations` comes from the topics alone, so a database that predates it (or an older
  // version of it) is backfilled from `events` right here, before any route can read it.
  if (getMeta.get('policy_index')?.value !== POLICY_INDEX_VERSION) {
    db.transaction(() => {
      clearPolicyNations.run();
      for (const row of policyEventRows.all()) {
        indexPolicy({
          eventName: row.event_name,
          category: row.category as FeedCategory,
          topics: JSON.parse(row.topics) as string[],
          blockNumber: BigInt(row.block_num),
          logIndex: row.log_index,
        });
      }
      setMeta.run('policy_index', POLICY_INDEX_VERSION);
    })();
  }

  return {
    close(): void {
      db.close();
    },

    getCursor(): Cursor {
      const nextFrom = getMeta.get('next_from')?.value;
      const confirmed = getMeta.get('confirmed_hash')?.value ?? '';
      return {
        nextFrom: nextFrom === undefined ? startBlock : BigInt(nextFrom),
        confirmedHash: confirmed === '' ? null : confirmed,
      };
    },

    /**
     * Append a decoded batch, fold it into the indexes, and advance the cursor, atomically.
     * `necromancy` carries the (leader, capital) the ingest loop read for each crediting
     * `NecromancyResolved` in the batch.
     */
    commit(
      logs: readonly StoredLog[],
      cursor: Cursor,
      necromancy: NecromancyCredits = new Map(),
    ): void {
      insertMany(logs, cursor, necromancy);
    },

    /** Drop everything at or above `fromBlock` and record the reorg for clients. */
    rewind(fromBlock: bigint, cursor: Cursor): void {
      rewindTx(fromBlock, this.headBlock(), cursor);
    },

    /** Block the service is current as of (the last block it has fully ingested). */
    headBlock(): bigint {
      const cursor = this.getCursor();
      return cursor.nextFrom > 0n ? cursor.nextFrom - 1n : 0n;
    },

    /** Start of the current round: feeds flush at RoundReset (07.2), so history does too. */
    roundStartBlock(): number {
      return latestRoundReset.get()?.block_num ?? 0;
    },

    /**
     * `/snapshot` payload: the newest `FEED_BUFFER_LIMITS[category]` events of each category
     * within the current round, merged into one chronological list.
     */
    snapshotLogs(): WireLog[] {
      const floor = this.roundStartBlock();
      const rows: EventRow[] = [];
      for (const [category, limit] of Object.entries(FEED_BUFFER_LIMITS)) {
        rows.push(...categoryPage.all(category, floor, limit));
      }
      return rows
        .sort((a, b) =>
          a.block_num === b.block_num
            ? a.log_index - b.log_index
            : a.block_num - b.block_num,
        )
        .map(toWire);
    },

    /**
     * `/events?since=` payload. Trimmed to a whole block so `asOfBlock` never claims a block
     * the client only half received.
     */
    eventsSince(
      since: bigint,
      rowLimit: number,
    ): { logs: WireLog[]; asOfBlock: bigint } {
      const head = this.headBlock();
      const rows = sinceBlock.all(Number(since), rowLimit + 1);
      if (rows.length <= rowLimit) {
        return { logs: rows.map(toWire), asOfBlock: head };
      }

      // Over the cap: cut at the last complete block, and let the client come back for more.
      const lastFull = rows[rowLimit - 1]?.block_num ?? Number(since);
      const kept = rows.filter((row) => row.block_num < lastFull);
      if (kept.length === 0) {
        // One block alone exceeds the cap — serve it whole rather than stall the cursor.
        const whole = rows.filter((row) => row.block_num === lastFull);
        return { logs: whole.map(toWire), asOfBlock: BigInt(lastFull) };
      }
      return { logs: kept.map(toWire), asOfBlock: BigInt(lastFull - 1) };
    },

    /**
     * `/policy?nation=` payload (U22.6): every current-round policy log whose topics carry
     * `nationId`, oldest first. Uncapped, unlike the `/snapshot` ring. Same round floor as
     * `/snapshot`.
     */
    policyLogs(nationId: number): WireLog[] {
      return nationPolicy.all(nationId, this.roundStartBlock()).map(toWire);
    },

    /**
     * Lowest block a reorg invalidated that a client at `since` may still hold, if any: the
     * rewound block is at or below `since`, and `since` is no newer than the head the rewind cut
     * back from. Once a client's cursor passes that head it is never told again.
     */
    reorgFrom(since: bigint): bigint | null {
      const row = reorgSince.get(Number(since), Number(since));
      return row?.block_num == null ? null : BigInt(row.block_num);
    },

    eventCount(): number {
      return countAll.get()?.n ?? 0;
    },

    /** False until `players` / `presence` have been folded from every stored event. */
    indexesReady(): boolean {
      return getMeta.get('indexes')?.value === INDEXES_VERSION;
    },

    /** Crediting `NecromancyResolved` logs already stored, for `rebuildIndexes`. */
    necromancyRequests(): NecromancyRequest[] {
      const out: NecromancyRequest[] = [];
      for (const row of necromancyRows.all()) {
        const request = necromancyRequest(toIndexable(row));
        if (request !== null) out.push(request);
      }
      return out;
    },

    /**
     * Re-derive both indexes from `events` (boot backfill — never a chain crawl). Runs when the
     * table predates the indexes; `necromancy` must cover every `necromancyRequests()` entry.
     */
    rebuildIndexes(necromancy: NecromancyCredits): void {
      rebuildTx(necromancy);
    },

    /** The round `/presence` serves: its id and the block of the `RoundReset` that opened it. */
    currentRound(): { roundId: bigint; startBlock: number } {
      const row = latestRoundResetRow.get();
      if (row === undefined) return { roundId: FIRST_ROUND_ID, startBlock: 0 };
      const topics = JSON.parse(row.topics) as string[];
      const roundTopic = topics[1];
      if (roundTopic === undefined) {
        throw new Error(`RoundReset at block ${row.block_num} has no roundId topic`);
      }
      return { roundId: BigInt(roundTopic), startBlock: row.block_num };
    },

    /** `/players`: every registered address, all rounds, ascending. */
    players(): string[] {
      return allPlayers.all().map((row) => row.player);
    },

    /** `/presence`: player → provinces for the current round, both ascending. */
    presence(): Record<string, number[]> {
      const out: Record<string, number[]> = {};
      for (const row of roundPresence.all(this.currentRound().startBlock)) {
        (out[row.player] ??= []).push(row.province);
      }
      return out;
    },

    /**
     * Current-round (player, province) pairs: all of them, or only those in `provinces`.
     * These are the pairs `/positions` reads `effectiveTroops` for (U22.3).
     */
    presencePairs(provinces?: Iterable<number>): PresencePair[] {
      const round = this.currentRound().startBlock;
      if (provinces === undefined) {
        return roundPresence.all(round).map((row) => ({
          player: row.player,
          province: row.province,
        }));
      }
      const out: PresencePair[] = [];
      for (const province of provinces) {
        for (const row of provincePresence.all(round, province)) {
          out.push({ player: row.player, province });
        }
      }
      return out;
    },

    /**
     * Every province with an `InfectionSpread` this round, ascending. Every `markInfected` emits
     * one and nothing clears an infection within a round, so this is the list `advanceInfection`
     * folds decay over (`infectedProvinces[roundId]`).
     */
    infectedProvinces(): number[] {
      const out = new Set<number>();
      for (const row of infectionTopics.all(this.roundStartBlock())) {
        const topic = (JSON.parse(row.topics) as string[])[1];
        if (topic === undefined) continue;
        const province = Number(BigInt(topic));
        if (province > 0) out.add(province);
      }
      return [...out].sort((a, b) => a - b);
    },
  };
}
