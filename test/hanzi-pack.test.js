import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, openSync, readFileSync, readSync, fstatSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildPack } from '../scripts/hanzi-pack.js';
import { components, openHanziPack, parseDecomposition } from '../lib/hanzi-pack.js';

const here = import.meta.dirname;
const inflate = async (bytes) => gunzipSync(bytes).toString('utf8');
const bufferReader = (buf) => ({ size: buf.length, read: async (o, n) => new Uint8Array(buf.subarray(o, o + n)) });

function fixturePack(perBlock) {
  return buildPack(readFileSync(`${here}/fixtures/mmah-graphics.txt`, 'utf8'),
    readFileSync(`${here}/fixtures/mmah-dictionary.txt`, 'utf8'), perBlock);
}

test('decomposition strings parse into trees', () => {
  assert.deepEqual(parseDecomposition('⿰女子'), { op: '⿰', children: [{ character: '女' }, { character: '子' }] });
  assert.deepEqual(parseDecomposition('⿱⿰木木一').children[0], { op: '⿰', children: [{ character: '木' }, { character: '木' }] });
  assert.deepEqual(components('⿱⿰木木？'), ['木']);
  assert.equal(parseDecomposition(''), null);
});

for (const perBlock of [1, 2, 32]) {
  test(`好 from a pack of ${perBlock} per block: 6 strokes, components 女 and 子`, async () => {
    const { bytes, count } = fixturePack(perBlock);
    assert.equal(count, 3);
    const pack = await openHanziPack(bufferReader(bytes), { inflate });
    const hao = await pack.get('好');
    assert.equal(hao.strokes.length, 6);
    assert.equal(hao.medians.length, 6);
    assert.equal(hao.radical, '女');
    assert.deepEqual(hao.pinyin, ['hǎo']);
    assert.equal(hao.etymology.type, 'ideographic');
    assert.deepEqual(components(hao.decomposition), ['女', '子']);
    const tree = await pack.tree('好');
    assert.equal(tree.op, '⿰');
    assert.deepEqual(tree.children.map((c) => c.character), ['女', '子']);
    assert.equal(tree.children[0].record.strokes.length, 3);
    assert.equal(tree.children[1].op, '⿻', '子 decomposes further');
    assert.equal(await pack.get('猫'), null);
    assert.equal(await pack.get(''), null);
  });
}

test('not a pack file', async () => {
  await assert.rejects(openHanziPack(bufferReader(Buffer.from('WLIDX...........')), { inflate }), /not a character data file/);
});

const FULL = process.env.HANZI_PACK || '/mnt/biglinks/hanzi/hanzi.pack';
test('the full Make Me a Hanzi pack', { skip: !existsSync(FULL) && `no ${FULL}` }, async () => {
  const fd = openSync(FULL, 'r');
  const reader = { size: fstatSync(fd).size, read: async (o, n) => { const b = Buffer.alloc(n); readSync(fd, b, 0, n, o); return new Uint8Array(b); } };
  const pack = await openHanziPack(reader, { inflate });
  assert.ok(pack.count > 9000);
  const hao = await pack.get('好');
  assert.equal(hao.strokes.length, 6);
  assert.deepEqual(components(hao.decomposition), ['女', '子']);
  assert.equal((await pack.get('一')).strokes.length, 1);
  assert.equal((await pack.get('龍')).radical, '龍');
});

test('words containing a character, most frequent first', async () => {
  const { fixtureDictionary } = await import('./helpers.js');
  const d = await fixtureDictionary();
  const rows = d.containing('好');
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.simp !== '好' && (r.simp.includes('好') || r.trad.includes('好'))), rows.map((r) => r.simp));
  assert.ok(rows.some((r) => r.simp === '你好'), rows.map((r) => r.simp));
  for (let i = 1; i < rows.length; i++) assert.ok(d.rank[rows[i - 1].id] <= d.rank[rows[i].id]);
  assert.equal(d.containing('好', 1).length, 1);
});
