// web/languages.js bookkeeping of data versions: the release date
// ("generated") and source extract date recorded per installed dictionary,
// when the catalogue was last checked, and what Diagnostics lists.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.window = globalThis.window || {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { Languages } = await import('../web/languages.js');

const STATE_KEY = 'wiktionary-lookup.state';
const SOURCE = { name: 'English Wiktionary via kaikki.org (wiktextract)', extracted: '2026-10-30' };

function manifest(generated, sha = 'aaa', extra = {}) {
  return {
    generated,
    source: { ...SOURCE, ...extra },
    languages: [{ code: 'de', name: 'German', entries: 10, bytes: 1000, sha256: sha, url: 'de.idx.gz' }],
    wikipedia: [{ kind: 'wikipedia', code: 'de', name: 'German Wikipedia', bytes: 5000, sha256: 'www', url: 'wikipedia-de.idx.gz' }],
  };
}

function languages() {
  const l = new Languages({ base: 'https://example.org/releases/', bundledIndexUrl: 'index.idx', bundledManifestUrl: 'manifest.json' });
  l.setBundled(false);
  // No network or Cache API here: a download "stores" its bytes in memory.
  l.fetchFile = async (entry) => ({ storage: 'cache', bytes: new ArrayBuffer(entry.bytes) });
  return l;
}

beforeEach(() => store.clear());

test('an install records the data release date and the source extract date', async () => {
  const l = languages();
  l.setCatalogue(manifest('2026-11-06T11:54:39.439Z'), 'remote');
  await l.install(l.catalogue.find((c) => c.code === 'de'));
  await l.install(l.catalogue.find((c) => c.code === 'wikipedia-de'));
  assert.equal(l.installed.de.generated, '2026-11-06T11:54:39.439Z');
  assert.equal(l.installed.de.extracted, '2026-10-30');
  // A Wikipedia index is not built from the Wiktionary extract.
  assert.equal(l.installed['wikipedia-de'].extracted, undefined);
  const saved = JSON.parse(store.get(STATE_KEY));
  assert.equal(saved.installed.de.extracted, '2026-10-30');
});

test('an install from before 0.13 gets its extract date from the catalogue it matches', () => {
  store.set(STATE_KEY, JSON.stringify({
    installed: { de: { code: 'de', name: 'German', sha256: 'aaa', bytes: 1000, generated: '2026-11-06T11:54:39.439Z' } },
    active: 'de',
  }));
  const l = languages();
  l.setCatalogue(manifest('2026-11-20T00:00:00.000Z', 'bbb'), 'remote');
  assert.equal(l.installed.de.extracted, undefined, 'a newer catalogue with another file says nothing about it');
  l.setCatalogue(manifest('2026-11-06T11:54:39.439Z', 'aaa'), 'saved');
  assert.equal(l.installed.de.extracted, '2026-10-30');
});

test('dataVersions and catalogueInfo: dates, size, update available', async () => {
  const l = languages();
  l.setCatalogue(manifest('2026-11-06T11:54:39.439Z'), 'remote');
  await l.install(l.catalogue.find((c) => c.code === 'de'));
  l.activate('de');
  assert.deepEqual(l.dataVersions(), [{
    code: 'de', name: 'German', active: true, bundled: false, generated: '2026-11-06T11:54:39.439Z',
    extracted: '2026-10-30', bytes: 1000, details: false, update: false,
  }]);
  l.setCatalogue(manifest('2026-12-01T00:00:00.000Z', 'ccc', { extracted: '2026-11-28' }), 'remote');
  const [de] = l.dataVersions();
  assert.equal(de.update, true);
  assert.equal(de.extracted, '2026-10-30', 'the installed file keeps its own dates');
  assert.deepEqual(l.catalogueInfo(), { generated: '2026-12-01T00:00:00.000Z', source: 'remote', checked: '' });
});

test('refreshCatalogue records when the catalogue was checked, and it is remembered', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(manifest('2026-11-06T11:54:39.439Z')), { status: 200 });
  try {
    const before = Date.now();
    const l = languages();
    await l.refreshCatalogue();
    const checked = Date.parse(l.catalogueInfo().checked);
    assert.ok(checked >= before - 1000 && checked <= Date.now() + 1000, l.catalogueInfo().checked);
    assert.equal(languages().catalogueChecked, l.catalogueChecked);
  } finally {
    globalThis.fetch = saved;
  }
});

test('a failed check keeps the previous time', async () => {
  store.set(STATE_KEY, JSON.stringify({ installed: {}, catalogueChecked: '2026-11-01T10:00:00.000Z' }));
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 502 });
  try {
    const l = languages();
    await assert.rejects(l.refreshCatalogue(), /HTTP 502/);
    assert.equal(l.catalogueInfo().checked, '2026-11-01T10:00:00.000Z');
  } finally {
    globalThis.fetch = saved;
  }
});
