#!/usr/bin/env node
/**
 * Re-copy the committed ABIs from the game repo and check the §16 catalog against the UI's.
 *
 * The indexer keeps its own copy of both, which is a drift risk (see src/catalog.ts). This is
 * the thing that makes the risk visible: run it after any redeploy or data-model change, and
 * in CI. It never edits the game repo.
 *
 *   GAME_REPO=/path/to/Conquestv2 node scripts/sync-abis.mjs [--check]
 *
 * `--check` fails instead of writing, for CI.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const gameRepo = resolve(process.env.GAME_REPO ?? join(repoRoot, '..', 'Conquestv2'));
const checkOnly = process.argv.includes('--check');

const ABI_FILES = [
  'AdminController.json',
  'PlayerRegistry.json',
  'Economy.json',
  'Combat.json',
  'TechWeapons.json',
  'Diplomacy.json',
];

const problems = [];

// --- ABIs -------------------------------------------------------------------
for (const file of ABI_FILES) {
  const source = join(gameRepo, 'ui/src/chain/abis', file);
  const target = join(repoRoot, 'src/abis', file);
  let incoming;
  try {
    incoming = readFileSync(source, 'utf8');
  } catch {
    problems.push(`missing in game repo: ${source}`);
    continue;
  }
  const current = readFileSync(target, 'utf8');
  if (current === incoming) continue;

  if (checkOnly) {
    problems.push(`ABI out of date: src/abis/${file}`);
  } else {
    writeFileSync(target, incoming);
    process.stdout.write(`updated src/abis/${file}\n`);
  }
}

// --- §16 catalog ------------------------------------------------------------
/** Pull the four `new Set([...])` blocks out of a source file, by order of appearance. */
function catalogSets(source) {
  const names = [];
  const setPattern = /new Set\(\[([^\]]*)\]\)/g;
  let match;
  while ((match = setPattern.exec(source)) !== null) {
    const entries = match[1]
      .split(',')
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
      .filter((entry) => entry !== '' && !entry.startsWith('//'));
    names.push(new Set(entries));
  }
  return names;
}

const uiCatalog = catalogSets(
  readFileSync(join(gameRepo, 'ui/src/chain/feedEvents.ts'), 'utf8'),
);
const ownCatalog = catalogSets(
  readFileSync(join(repoRoot, 'src/catalog.ts'), 'utf8'),
);

const CATEGORIES = ['activity', 'news', 'policy', 'meta'];
if (uiCatalog.length !== CATEGORIES.length) {
  problems.push(
    `could not read the UI catalog: found ${uiCatalog.length} sets, expected ${CATEGORIES.length}`,
  );
} else {
  CATEGORIES.forEach((category, index) => {
    const ui = uiCatalog[index];
    const own = ownCatalog[index] ?? new Set();
    for (const name of ui) {
      if (!own.has(name)) problems.push(`${category}: missing "${name}"`);
    }
    for (const name of own) {
      if (!ui.has(name)) problems.push(`${category}: extra "${name}"`);
    }
  });
}

if (problems.length > 0) {
  process.stderr.write(`\nout of sync with ${gameRepo}:\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.stderr.write(
    '\nCatalog differences must be fixed by hand in src/catalog.ts.\n',
  );
  process.exit(1);
}

process.stdout.write(`in sync with ${gameRepo}\n`);
