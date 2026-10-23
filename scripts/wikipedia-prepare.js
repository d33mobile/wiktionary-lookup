#!/usr/bin/env node
// Joins the English (or any) Wikipedia SQL dumps into one TSV that
// sources/wikipedia-titles.js turns into index entries:
//
//   node --max-old-space-size=4096 scripts/wikipedia-prepare.js DIR [--wiki enwiki] [--out FILE]
//
// Reads from DIR (dumps.wikimedia.org/<wiki>/latest/):
//   <wiki>-latest-page.sql.gz        page id, namespace, title, redirect flag
//   <wiki>-latest-redirect.sql.gz    redirect page id -> target title
//   <wiki>-latest-page_props.sql.gz  optional: 'wikibase-shortdesc' (short description)
//   clickstream-<wiki>-*.tsv.gz      optional: monthly clickstream; the clicks
//                                    into an article summed = its views
// and writes DIR/<wiki>-titles.tsv, one line per article (namespace 0, not a
// redirect), sorted by headword key (lib/normalize.js foldText of the
// title), then views, most first, so that entry ids follow the sorted
// order and a lazily read index finds neighbouring keys in neighbouring
// bytes:
//   title \t views \t short description \t redirect titles joined by \x1f
// Titles have spaces, not underscores. Redirects whose target is not an
// existing article (another redirect, a missing page) are dropped; a
// redirect to a section ("Foo#History") counts for its article.
//
// Everything streams; what is kept in memory is one title table of every
// namespace 0 page (UTF-8 bytes in Buffers, not JS strings), a Map from
// article title to article number and a few typed arrays.
import { createReadStream, createWriteStream, readdirSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { sqlRows } from './wikipedia-sql.js';
import { foldText } from '../lib/normalize.js';

const SHORTDESC = 'wikibase-shortdesc';
export const REDIRECT_SEPARATOR = '\x1f';

// Append-only table of strings stored as UTF-8 in one growing Buffer.
export class StringTable {
  constructor(capacity = 1 << 20) {
    this.bytes = Buffer.alloc(capacity);
    this.ends = new Uint32Array(1 << 16);
    this.length = 0;
    this.used = 0;
  }

  push(text) {
    const need = Buffer.byteLength(text);
    if (this.used + need > this.bytes.length) {
      const grown = Buffer.alloc(Math.max(this.bytes.length * 2, this.used + need));
      this.bytes.copy(grown, 0, 0, this.used);
      this.bytes = grown;
    }
    this.used += this.bytes.write(text, this.used);
    if (this.length === this.ends.length) {
      const grown = new Uint32Array(this.ends.length * 2);
      grown.set(this.ends);
      this.ends = grown;
    }
    this.ends[this.length] = this.used;
    return this.length++;
  }

  get(i) {
    return this.bytes.toString('utf8', i === 0 ? 0 : this.ends[i - 1], this.ends[i]);
  }
}

// Growable Uint32Array.
export class U32List {
  constructor() {
    this.a = new Uint32Array(1 << 16);
    this.length = 0;
  }

  push(v) {
    if (this.length === this.a.length) {
      const grown = new Uint32Array(this.a.length * 2);
      grown.set(this.a);
      this.a = grown;
    }
    this.a[this.length++] = v;
  }

  view() {
    return this.a.subarray(0, this.length);
  }
}

// Index of `id` in the ascending array `ids`, or -1.
export function findSorted(ids, id) {
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ids[mid] < id) lo = mid + 1;
    else hi = mid;
  }
  return lo < ids.length && ids[lo] === id ? lo : -1;
}

function progress(...args) {
  const rss = (process.memoryUsage().rss / 1048576).toFixed(0);
  console.log(`[${(performance.now() / 1000).toFixed(0)} s, rss ${rss} MiB]`, ...args);
}

function assertAscending(ids, what) {
  for (let i = 1; i < ids.length; i++) if (ids[i] <= ids[i - 1]) throw new Error(`${what}: page ids not ascending at ${i}`);
}

export async function prepare(dir, { wiki = 'enwiki', out = join(dir, `${wiki}-titles.tsv`), log = progress } = {}) {
  const file = (name) => join(dir, `${wiki}-latest-${name}`);
  const stats = {};

  // 1. Pages of namespace 0: articles and redirects, in page id order.
  const artIds = new U32List();
  const artTitles = new StringTable(256 << 20);
  const redIds = new U32List();
  const redTitles = new StringTable(256 << 20);
  for await (const [id, ns, title, isRedirect] of sqlRows(file('page.sql.gz'), ['page_id', 'page_namespace', 'page_title', 'page_is_redirect'])) {
    if (ns !== 0) continue;
    if (isRedirect) {
      redIds.push(id);
      redTitles.push(title);
    } else {
      artIds.push(id);
      artTitles.push(title);
    }
  }
  const articles = artIds.view();
  const redirectIds = redIds.view();
  assertAscending(articles, 'page.sql articles');
  assertAscending(redirectIds, 'page.sql redirects');
  stats.articles = articles.length;
  stats.redirectPages = redirectIds.length;
  log(`page.sql: ${articles.length} articles, ${redirectIds.length} redirects in namespace 0`);

  const articleByTitle = new Map();
  for (let i = 0; i < articles.length; i++) articleByTitle.set(artTitles.get(i), i);
  log('title map built');

  // 2. Redirects: (target article, redirect page) pairs.
  const pairArticle = new U32List();
  const pairRedirect = new U32List();
  let notArticle = 0;
  let toSection = 0;
  for await (const [from, ns, target, interwiki, fragment] of sqlRows(file('redirect.sql.gz'), ['rd_from', 'rd_namespace', 'rd_title', 'rd_interwiki', 'rd_fragment'])) {
    if (ns !== 0 || interwiki) continue;
    const r = findSorted(redirectIds, from);
    if (r < 0) continue;
    const a = articleByTitle.get(target);
    if (a === undefined) {
      notArticle++;
      continue;
    }
    if (fragment) toSection++;
    pairArticle.push(a);
    pairRedirect.push(r);
  }
  stats.redirects = pairArticle.length;
  stats.redirectsDropped = notArticle;
  stats.redirectsToSection = toSection;
  log(`redirect.sql: ${pairArticle.length} redirects to articles (${toSection} to a section), ${notArticle} to no article`);

  // 3. Short descriptions.
  const descOf = new Int32Array(articles.length).fill(-1);
  const descs = new StringTable(64 << 20);
  try {
    for await (const [page, name, value] of sqlRows(file('page_props.sql.gz'), ['pp_page', 'pp_propname', 'pp_value'])) {
      if (name !== SHORTDESC) continue;
      const a = findSorted(articles, page);
      if (a >= 0 && value) descOf[a] = descs.push(value.replace(/[\t\n\r\x1f]+/g, ' ').trim());
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    log('no page_props.sql.gz, no short descriptions');
  }
  stats.descriptions = descs.length;
  log(`page_props: ${descs.length} short descriptions`);

  // 4. Views from the clickstream (clicks into the article from anywhere).
  const views = new Float64Array(articles.length);
  const clickstream = readdirSync(dir).filter((f) => f.startsWith(`clickstream-${wiki}-`) && f.endsWith('.tsv.gz')).sort().pop();
  if (clickstream) {
    const lines = createInterface({ input: createReadStream(join(dir, clickstream)).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of lines) {
      const t1 = line.indexOf('\t');
      const t2 = line.indexOf('\t', t1 + 1);
      const t3 = line.indexOf('\t', t2 + 1);
      const a = articleByTitle.get(line.slice(t1 + 1, t2));
      if (a !== undefined) views[a] += Number(line.slice(t3 + 1));
    }
    stats.clickstream = clickstream;
    stats.withViews = views.reduce((n, v) => n + (v > 0), 0);
    log(`${clickstream}: ${stats.withViews} articles with views`);
  }
  articleByTitle.clear();

  // 5. Group redirects by article (counting sort) and write the TSV.
  const pa = pairArticle.view();
  const pr = pairRedirect.view();
  const start = new Uint32Array(articles.length + 1);
  for (let i = 0; i < pa.length; i++) start[pa[i] + 1]++;
  for (let i = 0; i < articles.length; i++) start[i + 1] += start[i];
  const fill = start.slice(0, articles.length);
  const grouped = new Uint32Array(pa.length);
  for (let i = 0; i < pa.length; i++) grouped[fill[pa[i]]++] = pr[i];
  const space = (t) => t.replaceAll('_', ' ');
  const keys = new Array(articles.length);
  for (let a = 0; a < articles.length; a++) keys[a] = foldText(space(artTitles.get(a)));
  const order = new Uint32Array(articles.length);
  for (let a = 0; a < order.length; a++) order[a] = a;
  order.sort((x, y) => (keys[x] < keys[y] ? -1 : keys[x] > keys[y] ? 1 : views[y] - views[x] || x - y));
  keys.length = 0;
  log('sorted by headword key');
  const output = createWriteStream(out);
  for (const a of order) {
    const redirects = [];
    for (let k = start[a]; k < start[a + 1]; k++) redirects.push(space(redTitles.get(grouped[k])));
    const line = `${space(artTitles.get(a))}\t${views[a]}\t${descOf[a] >= 0 ? descs.get(descOf[a]) : ''}\t${redirects.join(REDIRECT_SEPARATOR)}\n`;
    if (!output.write(line)) await once(output, 'drain');
  }
  output.end();
  await once(output, 'finish');
  log(`wrote ${out}`);
  return stats;
}

async function main(argv) {
  const opts = {};
  for (const flag of ['wiki', 'out']) {
    const i = argv.indexOf(`--${flag}`);
    if (i >= 0) [, opts[flag]] = argv.splice(i, 2);
  }
  if (argv.length !== 1) {
    console.error('usage: wikipedia-prepare.js DIR [--wiki enwiki] [--out FILE]');
    process.exit(2);
  }
  console.log(JSON.stringify(await prepare(argv[0], opts)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
}
