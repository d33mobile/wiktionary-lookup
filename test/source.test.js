import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine } from '../sources/cedict-text.js';
import { FIXTURE, countEntries } from './helpers.js';

test('parseLine extracts trad, simp, pinyin and definition', () => {
  assert.deepEqual(parseLine('你好 你好 [ni3 hao3] /hello; hi/'), {
    trad: '你好', simp: '你好', pinyin: 'ni3 hao3', definition: 'hello; hi',
  });
  assert.deepEqual(parseLine('綠 绿 [lu:4] /green/chlorine/'), {
    trad: '綠', simp: '绿', pinyin: 'lü4', definition: 'green/chlorine',
  });
  assert.equal(parseLine('# comment'), null);
  assert.equal(parseLine(''), null);
});

test('fixture yields every non-comment line', async () => {
  assert.ok((await countEntries(FIXTURE)) > 30);
});
