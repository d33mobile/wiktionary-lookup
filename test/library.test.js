// web/library.js: the favourites export carries the settings (0.13) and an
// import reads them back; exports from before 0.13 still import.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { exportFavourites, favourites, importFavourites, settingsOf, toggleFavourite } = await import('../web/library.js');

const entry = { simp: '你好', trad: '', pinyin: 'ni3 hao3', definition: 'hello' };
beforeEach(() => store.clear());

test('an export with settings round-trips them and the favourites', () => {
  toggleFavourite(entry, 'zh');
  const settings = { prefetch: 'always', pad: 'off', historyPaused: true };
  const text = exportFavourites(settings);
  const data = JSON.parse(text);
  assert.equal(data.format, 'wiktionary-lookup-favourites');
  assert.deepEqual(data.settings, settings);
  assert.deepEqual(settingsOf(text), settings);
  store.clear();
  assert.equal(importFavourites(text), 1);
  assert.equal(favourites()[0].simp, '你好');
});

test('exports without settings (before 0.13, plain arrays) still import, with no settings', () => {
  const old = JSON.stringify({ format: 'wiktionary-lookup-favourites', version: 1, favourites: [{ lang: 'zh', simp: '中国', t: 1 }] });
  assert.equal(settingsOf(old), null);
  assert.equal(importFavourites(old), 1);
  assert.equal(settingsOf(JSON.stringify([{ lang: 'zh', simp: '好', t: 2 }])), null);
  assert.equal(settingsOf('not json'), null);
  assert.equal(JSON.parse(exportFavourites()).settings, undefined);
});

test('unknown settings and invalid values are dropped', () => {
  const text = JSON.stringify({ favourites: [], settings: { prefetch: 'sometimes', pad: 'on', historyPaused: 'yes', other: 1 } });
  assert.deepEqual(settingsOf(text), { pad: 'on' });
  assert.equal(settingsOf(JSON.stringify({ favourites: [], settings: { prefetch: 'nope' } })), null);
});
