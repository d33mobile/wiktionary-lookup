import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../build-index.js';
import { serializeIndex } from '../lib/index-format.js';
import { openIndex } from '../lib/engine.js';
import { entries } from '../sources/cedict-text.js';
import { FIXTURE } from './helpers.js';
import { ENGINE_FILES } from '../stage-web.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = resolve(ROOT, 'lib', 'engine.js');
// Loaded by pages that open big indexes asynchronously; imports the engine.
const LAZY_ENTRY = resolve(ROOT, 'lib', 'lazy-index.js');
// Static and dynamic import specifiers, and the Node globals a browser lacks.
const IMPORT_RE = /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;
const NODE_GLOBAL_RE = /\b(?:Buffer|process|require|__dirname|__filename)\b|import\.meta\.(?:dirname|filename)/;

function importGraph(entry) {
  const seen = new Map();
  const visit = (file) => {
    if (seen.has(file)) return;
    const src = readFileSync(file, 'utf8');
    seen.set(file, src);
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${file} imports "${spec}", not a relative module`);
      visit(resolve(dirname(file), spec));
    }
  };
  visit(entry);
  return seen;
}

test('the engine module graph has only relative imports and no Node globals', () => {
  const graph = new Map([...importGraph(ENTRY), ...importGraph(LAZY_ENTRY)]);
  // stage-web.js copies exactly these files next to the page.
  assert.deepEqual([...graph.keys()].map((f) => f.slice(ROOT.length + 1)).sort(),
    ENGINE_FILES.map((f) => `lib/${f}`).sort());
  for (const [file, src] of graph) {
    const code = src.replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, NODE_GLOBAL_RE, file);
  }
});

test('openIndex accepts an ArrayBuffer as fetch() returns it', async () => {
  const bytes = serializeIndex(await buildIndex(entries(FIXTURE)));
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const d = openIndex(arrayBuffer);
  assert.equal(d.search('nihao')[0].simp, '你好');
});
