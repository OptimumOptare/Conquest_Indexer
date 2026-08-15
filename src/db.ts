/**
 * SQLite store. One append-only `events` table plus a cursor and a short reorg log.
 *
 * Sizing: a round is tens of thousands of logs — megabytes. SQLite on a Railway volume is the
 * right tool; Postgres would only buy multi-instance writes, which this service does not want
 * (one ingest loop, one cursor).
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { FEED_BUFFER_LIMITS, type FeedCategory } from './catalog.js';

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

    CREATE TABLE IF NOT EXISTS reorgs (
      block_num INTEGER PRIMARY KEY,
      seen_at   INTEGER NOT NULL
    );
  `);

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

  const insertMany = db.transaction(
    (logs: readonly StoredLog[], cursor: Cursor) => {
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
      }
      setMeta.run('next_from', cursor.nextFrom.toString());
      setMeta.run('confirmed_hash', cursor.confirmedHash ?? '');
    },
  );

  const deleteFrom = db.prepare('DELETE FROM events WHERE block_num >= ?');
  const insertReorg = db.prepare(
    'INSERT INTO reorgs (block_num, seen_at) VALUES (?, ?) ' +
      'ON CONFLICT(block_num) DO UPDATE SET seen_at = excluded.seen_at',
  );
  const pruneReorgs = db.prepare('DELETE FROM reorgs WHERE block_num < ?');

  const rewindTx = db.transaction((fromBlock: bigint, cursor: Cursor) => {
    deleteFrom.run(Number(fromBlock));
    insertReorg.run(Number(fromBlock), Date.now());
    pruneReorgs.run(Number(fromBlock) - 10_000);
    setMeta.run('next_from', cursor.nextFrom.toString());
    setMeta.run('confirmed_hash', cursor.confirmedHash ?? '');
  });

  const latestRoundReset = db.prepare<[], { block_num: number }>(
    "SELECT MAX(block_num) AS block_num FROM events WHERE event_name = 'RoundReset'",
  );

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

  const reorgSince = db.prepare<[number], { block_num: number }>(
    'SELECT MIN(block_num) AS block_num FROM reorgs WHERE block_num <= ?',
  );

  const countAll = db.prepare<[], { n: number }>(
    'SELECT COUNT(*) AS n FROM events',
  );

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

    /** Append a decoded batch and advance the cursor atomically. */
    commit(logs: readonly StoredLog[], cursor: Cursor): void {
      insertMany(logs, cursor);
    },

    /** Drop everything at or above `fromBlock` and record the reorg for clients. */
    rewind(fromBlock: bigint, cursor: Cursor): void {
      rewindTx(fromBlock, cursor);
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

    /** Lowest block a reorg invalidated at or below `since`, if any. */
    reorgFrom(since: bigint): bigint | null {
      const row = reorgSince.get(Number(since));
      return row?.block_num == null ? null : BigInt(row.block_num);
    },

    eventCount(): number {
      return countAll.get()?.n ?? 0;
    },
  };
}
