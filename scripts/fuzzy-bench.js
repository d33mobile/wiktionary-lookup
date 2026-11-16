#!/usr/bin/env node
// Usage: node scripts/fuzzy-bench.js INDEX [QUERY...]
// Latency of the fuzzy fallback (queries that find nothing otherwise) on
// an index loaded whole and opened lazily (lib/lazy-index.js, a fresh open
// per query, so nothing is cached from the query before): median and worst
// over the queries, and the rounds of reads (Dictionary.retry) the lazy
// search needed beyond its key ranges.
import { loadIndex, openIndexLazy, nodeFileReader } from '../lookup.js';

const DEFAULT_QUERIES = ['howizer', 'howitzr', 'hjowitzer', 'ingenous', 'acommodate', 'dictionray', 'elephnat', 'umbrela',
  'keybaord', 'xylophnoe'];
const EAGER_ROUNDS = 20;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

async function lazySearch(path, q) {
  const d = await openIndexLazy(await nodeFileReader(path));
  let rounds = 0;
  const retry = async (fn) => {
    for (;;) {
      try {
        return fn();
      } catch (err) {
        rounds++;
        if (err.ranges) await d.blockCache.loadAll(err.ranges);
        else await d.blockCache.load(err.offset, err.length);
      }
    }
  };
  const session = d.newSession();
  const reads0 = d.blockCache.reads;
  const bytes0 = d.blockCache.readBytes;
  const t0 = performance.now();
  await retry(() => session.candidates(q, { rangesOnly: true }));
  const rangeRounds = rounds;
  const found = await retry(() => session.candidates(q));
  const rows = await d.entriesAsync(found);
  const ms = performance.now() - t0;
  const out = {
    ms, rounds, rangeRounds, reads: d.blockCache.reads - reads0, bytes: d.blockCache.readBytes - bytes0, rows,
  };
  await d.close();
  return out;
}

async function main(argv) {
  if (argv.length < 1) {
    console.error('usage: fuzzy-bench.js INDEX [QUERY...]');
    process.exit(2);
  }
  const [path, ...given] = argv;
  const queries = given.length ? given : DEFAULT_QUERIES;
  const d = await loadIndex(path, { details: false });
  console.log(`${path}: ${d.size} entries`);
  console.log('query        | first result      | d | scanned | eager ms | lazy ms | rounds (ranges + rest) | reads | MiB');
  console.log('-------------|-------------------|---|---------|----------|---------|------------------------|-------|-----');
  const eager = [];
  const lazy = [];
  const extra = [];
  for (const q of queries) {
    const times = [];
    let rows = [];
    let stats = null;
    for (let r = 0; r < EAGER_ROUNDS; r++) {
      const session = d.newSession();
      const t0 = performance.now();
      rows = session.search(q);
      times.push(performance.now() - t0);
      if (r === 0) stats = session.lastStats;
    }
    const e = median(times);
    eager.push(e);
    const l = await lazySearch(path, q);
    lazy.push(l.ms);
    extra.push(l.rounds - l.rangeRounds);
    const same = JSON.stringify(l.rows) === JSON.stringify(rows);
    const first = rows.length ? `${rows[0].simp}${rows[0].fuzzy ? ` ~${rows[0].fuzzy}` : ''}` : '-';
    console.log(`${q.padEnd(12)} | ${first.padEnd(17)} | ${String(rows.length ? rows[0].fuzzy || 0 : '-')} | ${String(stats.fuzzy ? stats.fuzzy.scanned : 0).padStart(7)} | ${e.toFixed(1).padStart(8)} | ${l.ms.toFixed(0).padStart(7)} | ${`${l.rounds} (${l.rangeRounds} + ${l.rounds - l.rangeRounds})`.padStart(22)} | ${String(l.reads).padStart(5)} | ${(l.bytes / 1048576).toFixed(1)}${same ? '' : ' DIFFERENT RESULTS'}`);
  }
  const worst = (xs) => Math.max(...xs);
  console.log(`eager (median of ${EAGER_ROUNDS} runs per query): median ${median(eager).toFixed(1)} ms, worst ${worst(eager).toFixed(1)} ms`);
  console.log(`lazy (cold open per query): median ${median(lazy).toFixed(0)} ms, worst ${worst(lazy).toFixed(0)} ms; rounds after the key ranges: median ${median(extra)}, worst ${worst(extra)}`);
}

main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
