#!/usr/bin/env node
// Usage: node bench.js INDEX
// Reports cold index load time and per-keystroke search latency, incremental
// (one Session typing character by character) versus non-incremental (a
// fresh Session per query, i.e. full bisect every time).
import { loadIndex } from './lookup.js';

const ROUNDS = 200;
const SEQUENCES = [
  ['n', 'ni', 'nih', 'niha', 'nihao'],
  ['中', '中国'],
];

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

function timeUs(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1000;
}

function benchSequence(d, prefixes) {
  const rows = prefixes.map((q) => ({ q, incremental: [], fresh: [], results: 0, searched: 0 }));
  for (let r = 0; r < ROUNDS; r++) {
    const session = d.newSession();
    for (const row of rows) {
      row.incremental.push(timeUs(() => { row.results = session.search(row.q).length; }));
      row.searched = session.lastStats.searched;
    }
    for (const row of rows) {
      const fresh = d.newSession();
      row.fresh.push(timeUs(() => fresh.search(row.q)));
    }
  }
  return rows;
}

async function main(argv) {
  if (argv.length !== 1) {
    console.error('usage: bench.js INDEX');
    process.exit(2);
  }
  const t0 = performance.now();
  const d = await loadIndex(argv[0]);
  const loadMs = performance.now() - t0;
  const mem = process.memoryUsage();
  console.log(`cold load: ${loadMs.toFixed(1)} ms, ${d.size} entries, rss ${(mem.rss / 1048576).toFixed(0)} MiB, heap ${(mem.heapUsed / 1048576).toFixed(0)} MiB`);
  console.log(`per-keystroke latency, median of ${ROUNDS} rounds (us = microseconds)`);
  console.log('query     | hits | scanned | incremental us | fresh us');
  console.log('----------|------|---------|----------------|---------');
  for (const seq of SEQUENCES) {
    for (const row of benchSequence(d, seq)) {
      console.log(`${row.q.padEnd(9)} | ${String(row.results).padStart(4)} | ${String(row.searched).padStart(7)} | ${median(row.incremental).toFixed(1).padStart(14)} | ${median(row.fresh).toFixed(1).padStart(8)}`);
    }
  }
  console.log('"scanned" = size of the range the bisect ran inside (incremental session).');
}

main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
