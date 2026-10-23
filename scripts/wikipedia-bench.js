#!/usr/bin/env node
// Load time, memory and per-keystroke latency of a (Wikipedia) index:
//
//   node scripts/wikipedia-bench.js INDEX [--rounds N] [--lazy] [QUERY ...]
//
// Each QUERY is typed character by character in one Session (incremental)
// and every prefix is also searched in a fresh Session (full bisect); the
// table shows the medians for the prefixes. Default queries: "new york"
// and "東京". --lazy loads the index with openIndexFile (byte-range reads)
// instead of reading the whole file. RSS is measured after loading and
// again after the benchmark.
import { loadIndex, openIndexFile } from '../lookup.js';

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

function timeUs(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1000;
}

const mib = (bytes) => `${(bytes / 1048576).toFixed(0)} MiB`;

async function main(argv) {
  let rounds = 50;
  const r = argv.indexOf('--rounds');
  if (r >= 0) rounds = Number(argv.splice(r, 2)[1]);
  const l = argv.indexOf('--lazy');
  const lazy = l >= 0;
  if (lazy) argv.splice(l, 1);
  const [path, ...queries] = argv;
  if (!path) {
    console.error('usage: wikipedia-bench.js INDEX [--rounds N] [--lazy] [QUERY ...]');
    process.exit(2);
  }
  if (queries.length === 0) queries.push('new york', '東京');
  const t0 = performance.now();
  const d = lazy ? openIndexFile(path) : await loadIndex(path);
  const loadMs = performance.now() - t0;
  const t1 = performance.now();
  d.newSession().search('a');
  const firstMs = performance.now() - t1;
  const m = process.memoryUsage();
  console.log(`${lazy ? 'lazy' : 'eager'} load ${loadMs.toFixed(0)} ms, first search ${firstMs.toFixed(0)} ms, ${d.size} entries,`
    + ` rss ${mib(m.rss)}, heap ${mib(m.heapUsed)}, external+arrayBuffers ${mib(m.external + m.arrayBuffers)}`);
  console.log(`median of ${rounds} rounds, microseconds`);
  console.log('query      | hits | scanned  | incremental | fresh   | top result');
  console.log('-----------|------|----------|-------------|---------|-----------');
  for (const query of queries) {
    const prefixes = [];
    for (const ch of query) prefixes.push((prefixes.at(-1) ?? '') + ch);
    const rows = prefixes.map((q) => ({ q, inc: [], fresh: [], hits: 0, searched: 0, top: '' }));
    for (let k = 0; k < rounds; k++) {
      const s = d.newSession();
      for (const row of rows) {
        let res;
        row.inc.push(timeUs(() => { res = s.search(row.q); }));
        row.hits = res.length;
        row.searched = s.lastStats.searched;
        row.top = res[0] ? `${res[0].simp} <${res[0].matchedOn}>` : '';
      }
      for (const row of rows) {
        const f = d.newSession();
        row.fresh.push(timeUs(() => f.search(row.q)));
      }
    }
    for (const row of rows) {
      console.log(`${row.q.padEnd(10)} | ${String(row.hits).padStart(4)} | ${String(row.searched).padStart(8)} | ${median(row.inc).toFixed(0).padStart(11)} | ${median(row.fresh).toFixed(0).padStart(7)} | ${row.top}`);
    }
  }
  console.log(`rss after the benchmark ${mib(process.memoryUsage().rss)}`);
}

main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
