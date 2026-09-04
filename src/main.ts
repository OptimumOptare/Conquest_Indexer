/**
 * Entry point: open the store, start the ingest loop, serve HTTP.
 *
 * The HTTP surface comes up immediately, before catch-up finishes: a client that gets a
 * near-empty `/snapshot` sees a shallow feed for a few minutes, which is strictly better than
 * a connection refused that sends it back to crawling the chain itself.
 */

import { loadConfig } from './config.js';
import { openStore } from './db.js';
import {
  createBackfillClient,
  createIngestor,
  createRpcClient,
} from './ingest.js';
import { startServer } from './server.js';

const config = loadConfig();
const store = openStore(config.dbPath, config.startBlock);
const ingestor = createIngestor(
  config,
  store,
  createRpcClient(config),
  createBackfillClient(config),
);
const server = startServer(config, store, ingestor);

void ingestor.start();

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n${signal} — draining\n`);
    ingestor.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    // Railway sends SIGTERM and waits; do not make it wait forever on an in-flight RPC.
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
