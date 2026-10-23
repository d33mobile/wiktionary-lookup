import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare } from '../scripts/wikipedia-prepare.js';
import { parseTuples } from '../scripts/wikipedia-sql.js';
import { entries, entryOf, articleUrl } from '../sources/wikipedia-titles.js';
import { buildIndex } from '../build-index.js';
import { serializeIndex } from '../lib/index-format.js';
import { openIndex, openIndexFile } from '../lookup.js';
import { entries as cedictEntries } from '../sources/cedict-text.js';
import { FIXTURE as CEDICT_FIXTURE } from './helpers.js';

function dump(table, columns, rows, { perLine = true } = {}) {
  const create = `CREATE TABLE \`${table}\` (\n${columns.map((c) => `  \`${c}\` varbinary(255) NOT NULL,`).join('\n')}\n  PRIMARY KEY (\`${columns[0]}\`)\n) ENGINE=InnoDB;\n`;
  const values = rows.map((r) => `(${r.map((v) => (typeof v === 'number' ? v : v === null ? 'NULL' : `'${v}'`)).join(',')})`);
  const insert = perLine
    ? `INSERT INTO \`${table}\` VALUES\n${values.join(',\n')};\n`
    : `INSERT INTO \`${table}\` VALUES ${values.join(',')};\n`;
  return gzipSync(`-- comment (with parens)\n${create}${insert}`);
}

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const quiet = { log: () => {} };

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'wikipedia-titles-'));
  dirs.push(dir);
  const page = ['page_id', 'page_namespace', 'page_title', 'page_is_redirect', 'page_len'];
  writeFileSync(join(dir, 'enwiki-latest-page.sql.gz'), dump('page', page, [
    [1, 0, 'New_York_City', 0, 900],
    [2, 0, 'NYC', 1, 10],
    [3, 0, 'New_York', 0, 800],
    [4, 0, 'New_york_city', 1, 10],
    [5, 1, 'New_York_City', 0, 5],
    [6, 0, 'Big_Apple', 1, 10],
    [7, 0, 'Dangling', 1, 10],
    [8, 0, 'Tokyo', 0, 700],
    [9, 0, '東京', 1, 10],
    [10, 0, 'O\\\'Hare_International_Airport', 0, 600],
    [11, 0, 'Newark,_New_Jersey', 0, 500],
  ]));
  writeFileSync(join(dir, 'enwiki-latest-redirect.sql.gz'), dump('redirect', ['rd_from', 'rd_namespace', 'rd_title', 'rd_interwiki', 'rd_fragment'], [
    [2, 0, 'New_York_City', '', ''],
    [4, 0, 'New_York_City', '', ''],
    [6, 0, 'New_York_City', '', 'Nickname'],
    [7, 0, 'Nowhere', '', ''],
    [9, 0, 'Tokyo', '', ''],
  ], { perLine: false }));
  writeFileSync(join(dir, 'enwiki-latest-page_props.sql.gz'), dump('page_props', ['pp_page', 'pp_propname', 'pp_value', 'pp_sortkey'], [
    [1, 'wikibase-shortdesc', 'Most populous city in the United States', null],
    [1, 'wikibase_item', 'Q60', null],
    [3, 'wikibase-shortdesc', 'State of the United States', null],
    [8, 'wikibase-shortdesc', 'Capital of Japan', null],
  ]));
  writeFileSync(join(dir, 'clickstream-enwiki-2026-09.tsv.gz'), gzipSync([
    'other-search\tNew_York_City\texternal\t5000',
    'Main_Page\tNew_York_City\tlink\t3000',
    'other-search\tNew_York\texternal\t1000',
    'other-search\tNewark,_New_Jersey\texternal\t20',
    'other-search\tNot_an_article\texternal\t99',
  ].join('\n')));
  return dir;
}

test('SQL tuples: escapes, NULL, numbers, wanted columns only', () => {
  const rows = [];
  parseTuples("INSERT INTO `t` VALUES (1,'a\\'b\\\\c',NULL,2.5),(2,'x,(y)','',-3);", 22, [0, 1, 2, 3], 4, (r) => rows.push(r));
  assert.deepEqual(rows, [[1, "a'b\\c", null, 2.5], [2, 'x,(y)', '', -3]]);
  const some = [];
  parseTuples("(7,'skip\\'me','keep')", 0, [0, -1, 1], 2, (r) => some.push(r));
  assert.deepEqual(some, [[7, 'keep']]);
});

test('prepare: articles with redirects, descriptions and views', async () => {
  const dir = fixtureDir();
  const stats = await prepare(dir, quiet);
  assert.equal(stats.articles, 5);
  assert.equal(stats.redirects, 4);
  assert.equal(stats.redirectsDropped, 1, 'Dangling points to no article');
  assert.equal(stats.redirectsToSection, 1);
  const lines = readFileSync(join(dir, 'enwiki-titles.tsv'), 'utf8').trim().split('\n');
  assert.equal(lines[0], 'New York City\t8000\tMost populous city in the United States\tNYC\x1fNew york city\x1fBig Apple');
  assert.equal(lines[3], "O'Hare International Airport\t0\t\t");
  const nyc = entryOf(lines[0]);
  assert.deepEqual(nyc.forms, ['NYC', 'Big Apple'], 'a case variant of the title is dropped');
  assert.equal(nyc.freq, Math.round(Math.log2(8000) * 16));
  assert.equal(entryOf(lines[3]).freq, undefined);
});

test('index: titles, redirects as alternative forms, ranking by views', async () => {
  const dir = fixtureDir();
  await prepare(dir, quiet);
  const info = {};
  const sections = await buildIndex(entries(join(dir, 'enwiki-titles.tsv'), info), info);
  assert.equal(info.entryUrl, 'https://en.wikipedia.org/wiki/{title}');
  const d = openIndex(serializeIndex(sections, info));
  const titles = (q) => d.search(q).map((r) => r.simp);
  assert.deepEqual(titles('new york'), ['New York', 'New York City']);
  assert.deepEqual(titles('new'), ['New York City', 'New York', 'Newark, New Jersey'], 'more views first');
  assert.deepEqual(titles('nyc'), ['New York City']);
  assert.equal(d.search('big app')[0].matchedOn, 'forms');
  assert.deepEqual(titles('東京'), ['Tokyo']);
  assert.deepEqual(titles('ohare'), [], 'apostrophes are kept in headword keys');
  assert.deepEqual(titles("o'hare"), ["O'Hare International Airport"]);
  assert.deepEqual(titles('capital of japan'), ['Tokyo'], 'short description');
  assert.equal(articleUrl('en', "O'Hare International Airport"), 'https://en.wikipedia.org/wiki/O\'Hare_International_Airport');
  assert.equal(d.search('nyc')[0].url, 'https://en.wikipedia.org/wiki/New_York_City');
  assert.equal(d.search("o'hare")[0].url, articleUrl('en', "O'Hare International Airport"));
});

test('byte offsets: eager and lazy loading give the same results as code-unit offsets', async () => {
  const dir = fixtureDir();
  await prepare(dir, quiet);
  const path = join(dir, 'enwiki-titles.tsv');
  const bytesInfo = {};
  const bytesSections = await buildIndex(entries(path, bytesInfo), bytesInfo);
  assert.equal(bytesInfo.textOffsets, 'bytes');
  // The same entries with code-unit offsets, the format every other source writes.
  const unitsInfo = {};
  async function* codeUnits() {
    yield* entries(path, unitsInfo);
    delete unitsInfo.textOffsets;
  }
  const units = openIndex(serializeIndex(await buildIndex(codeUnits(), unitsInfo), unitsInfo));
  assert.equal(typeof units.blob, 'string');
  const file = join(dir, 'enwiki.idx');
  writeFileSync(file, serializeIndex(bytesSections, bytesInfo));
  const eager = openIndex(readFileSync(file));
  // residentBytes 0: every section that may stay on disk does.
  const lazy = openIndexFile(file, { residentBytes: 0 });
  assert.notEqual(typeof eager.blob, 'string');
  for (const q of ['new', 'new york', 'nyc', '東京', 'big apple', "o'hare", 'capital of japan', 'united', 'state of', 'uni']) {
    const expected = units.search(q);
    assert.deepEqual(eager.search(q), expected, q);
    assert.deepEqual(lazy.search(q), expected, q);
  }
  lazy.close();
});

test('lazy loading of an index with code-unit offsets (CC-CEDICT fixture)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wikipedia-titles-'));
  dirs.push(dir);
  const file = join(dir, 'cedict.idx');
  writeFileSync(file, serializeIndex(await buildIndex(cedictEntries(CEDICT_FIXTURE))));
  const eager = openIndex(readFileSync(file));
  const lazy = openIndexFile(file, { residentBytes: 0 });
  let hits = 0;
  for (const q of ['ni', 'nihao', 'zhong1 guo2', '中', 'man', 'shit', '/to be', 'p:ban', 'ba', 'what']) {
    const expected = eager.search(q);
    hits += expected.length;
    assert.deepEqual(lazy.search(q), expected, q);
  }
  assert.ok(hits > 20, `${hits} hits`);
  assert.ok(!('url' in eager.search('nihao')[0]), 'no entryUrl in the header: no url');
  lazy.close();
});
