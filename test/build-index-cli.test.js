import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIndex } from '../lookup.js';

// The CLI runs main() at module load: every top-level declaration it uses
// must be initialised by then (a const declared after the entry block threw
// "Cannot access 'DETAILS_MODES' before initialization").
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = (...args) => execFileSync(process.execPath, [join(ROOT, 'build-index.js'), ...args], { encoding: 'utf8' });

test('build-index.js CLI: sidecar by default, embedded and none on request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'build-index-cli-'));
  const de = join(ROOT, 'test', 'fixtures', 'wiktionary-de.jsonl');
  const out = cli('wiktionary', de, join(dir, 'de.idx'));
  assert.match(out, /wrote .*de\.idx/);
  assert.ok(existsSync(join(dir, 'de.details')), 'sidecar written');
  const d = await loadIndex(join(dir, 'de.idx'));
  assert.equal(d.search('haus')[0].simp, 'Haus');
  assert.equal((await d.getDetails(d.search('haus')[0].id)).title, 'Haus');

  cli('wiktionary', de, join(dir, 'emb.idx'), '--details', 'embedded');
  assert.ok(!existsSync(join(dir, 'emb.details')));
  const e = await loadIndex(join(dir, 'emb.idx'));
  assert.equal((await e.getDetails(e.search('haus')[0].id)).title, 'Haus');

  cli('cedict-text', join(ROOT, 'test', 'fixtures', 'mini-cedict.txt'), join(dir, 'c.idx'), '--details', 'none');
  assert.equal((await loadIndex(join(dir, 'c.idx'))).search('nihao')[0].simp, '你好');

  assert.throws(() => execFileSync(process.execPath, [join(ROOT, 'build-index.js'), 'wiktionary', de, join(dir, 'x.idx'), '--details', 'bogus'], { stdio: 'pipe' }), /usage/);
});
