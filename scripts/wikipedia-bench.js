#!/usr/bin/env node
// Open time, memory and per-keystroke latency of an index, by way of opening:
//
//   node scripts/wikipedia-bench.js INDEX [--mode M] [--rounds N] [QUERY ...]
//
//   --mode eager        loadIndex: read and decode the whole file (default)
//          file         openIndexFile: synchronous byte-range reads
//          lazy         openIndexLazy over nodeFileReader, searchAsync
//          progressive  openIndexProgressive over nodeFileReader: time to
//                       the first searchable state and to the full one
//   --lazy              same as --mode file (older name)
//
// Each QUERY is typed character by character in one Session (incremental)
// and every prefix is also searched in a fresh Session; the table shows
// the medians over the rounds and, as "first", the incremental time of the
// first round (cold BlockCache in lazy mode). Default queries: "new york"
// and "東京". RSS is measured after opening and after the benchmark.
import { loadIndex, openIndexFile, openIndexLazy, openIndexProgressive, nodeFileReader } from '../lookup.js';

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

async function timeUs(fn) {
  const t0 = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t0) / 1000;
}

const mib = (bytes) => `${(bytes / 1048576).toFixed(0)} MiB`;
const MODES = ['eager', 'file', 'lazy', 'progressive'];

async function open(path, mode) {
  if (mode === 'eager') return { d: await loadIndex(path, { details: false }) };
  if (mode === 'file') return { d: openIndexFile(path, { details: false }) };
  if (mode === 'lazy') return { d: await openIndexLazy(await nodeFileReader(path)) };
  const t0 = performance.now();
  let searchableMs = null;
  const d = await openIndexProgressive(await nodeFileReader(path), {
    onSearchable: () => { searchableMs = performance.now() - t0; },
  });
  return { d, note: `first searchable after ${searchableMs.toFixed(0)} ms` };
}

async function main(argv) {
  let rounds = 50;
  let mode = 'eager';
  const r = argv.indexOf('--rounds');
  if (r >= 0) rounds = Number(argv.splice(r, 2)[1]);
  const m = argv.indexOf('--mode');
  if (m >= 0) mode = argv.splice(m, 2)[1];
  const l = argv.indexOf('--lazy');
  if (l >= 0) {
    argv.splice(l, 1);
    mode = 'file';
  }
  const [path, ...queries] = argv;
  if (!path || !MODES.includes(mode)) {
    console.error(`usage: wikipedia-bench.js INDEX [--mode ${MODES.join('|')}] [--rounds N] [QUERY ...]`);
    process.exit(2);
  }
  if (queries.length === 0) queries.push('new york', '東京');
  const search = (session, q) => (mode === 'lazy' ? session.searchAsync(q) : session.search(q));
  const t0 = performance.now();
  const { d, note } = await open(path, mode);
  const loadMs = performance.now() - t0;
  const t1 = performance.now();
  await search(d.newSession(), 'a');
  const firstMs = performance.now() - t1;
  const mem = process.memoryUsage();
  console.log(`${mode} open ${loadMs.toFixed(0)} ms${note ? ` (${note})` : ''}, first search ${firstMs.toFixed(0)} ms, ${d.size} entries,`
    + ` rss ${mib(mem.rss)}, heap ${mib(mem.heapUsed)}, external+arrayBuffers ${mib(mem.external + mem.arrayBuffers)}`);
  console.log(`median of ${rounds} rounds, microseconds`);
  console.log('query      | hits | first    | incremental | fresh   | top result');
  console.log('-----------|------|----------|-------------|---------|-----------');
  for (const query of queries) {
    const prefixes = [];
    for (const ch of query) prefixes.push((prefixes.length ? prefixes[prefixes.length - 1] : '') + ch);
    const rows = prefixes.map((q) => ({ q, inc: [], fresh: [], hits: 0, top: '' }));
    for (let k = 0; k < rounds; k++) {
      const s = d.newSession();
      for (const row of rows) {
        let res;
        row.inc.push(await timeUs(async () => { res = await search(s, row.q); }));
        row.hits = res.length;
        row.top = res[0] ? `${res[0].simp} <${res[0].matchedOn}>` : '';
      }
      for (const row of rows) {
        const f = d.newSession();
        row.fresh.push(await timeUs(() => search(f, row.q)));
      }
    }
    for (const row of rows) {
      console.log(`${row.q.padEnd(10)} | ${String(row.hits).padStart(4)} | ${row.inc[0].toFixed(0).padStart(8)} | ${median(row.inc).toFixed(0).padStart(11)} | ${median(row.fresh).toFixed(0).padStart(7)} | ${row.top}`);
    }
  }
  const cache = d.blockCache;
  if (cache) console.log(`block cache: ${cache.reads} reads, ${mib(cache.readBytes)} read, ${mib(cache.bytes)} held`);
  console.log(`rss after the benchmark ${mib(process.memoryUsage().rss)}`);
}

main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
