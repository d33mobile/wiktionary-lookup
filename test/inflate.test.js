// web/inflate.js against node:zlib: synthetic inputs that hit stored, fixed
// and dynamic blocks and multi-member files, plus real language indexes from
// the data release when they are on this machine (WIKTIONARY_RELEASE_DIR,
// default /mnt/biglinks/wiktionary/release).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync, constants } from 'node:zlib';
import { gunzip } from '../web/inflate.js';

const RELEASE_DIR = process.env.WIKTIONARY_RELEASE_DIR ?? '/mnt/biglinks/wiktionary/release';
const REAL_INDEXES = ['smj', 'ab', 'kw', 'de'];

function pseudoRandom(n, seed) {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

test('synthetic inputs match zlib', () => {
  const text = new TextEncoder().encode('Haus house/building; household\n'.repeat(5000) + '漢字 hanzi 汉字\n'.repeat(300));
  const inputs = {
    empty: new Uint8Array(0),
    oneByte: new Uint8Array([42]),
    text,
    random: pseudoRandom(200000, 7),
    mixed: new Uint8Array([...pseudoRandom(70000, 3), ...text.subarray(0, 90000)]),
  };
  for (const [name, data] of Object.entries(inputs)) {
    for (const level of [0, 1, 6, 9]) {
      for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FIXED, constants.Z_HUFFMAN_ONLY]) {
        const gz = gzipSync(data, { level, strategy });
        assert.deepEqual(Buffer.from(gunzip(gz)), Buffer.from(data), `${name} level ${level} strategy ${strategy}`);
        assert.deepEqual(Buffer.from(gunzip(gz, data.length)), Buffer.from(data), `${name} with size hint`);
      }
    }
  }
});

test('concatenated members and a gzip header with a file name', () => {
  const a = gzipSync(new TextEncoder().encode('first member '));
  const b = gzipSync(new TextEncoder().encode('second member'));
  assert.equal(new TextDecoder().decode(gunzip(Buffer.concat([a, b]))), 'first member second member');
  // FNAME flag: "x.idx\0" after the 10-byte header.
  const named = Buffer.concat([a.subarray(0, 3), Buffer.from([8]), a.subarray(4, 10), Buffer.from('x.idx\0'), a.subarray(10)]);
  assert.equal(new TextDecoder().decode(gunzip(named)), 'first member ');
});

test('corrupt input is rejected', () => {
  const gz = gzipSync(new TextEncoder().encode('Haus '.repeat(1000)));
  assert.throws(() => gunzip(gz.subarray(0, gz.length - 20)));
  assert.throws(() => gunzip(new Uint8Array([1, 2, 3, 4])), /not gzip/);
});

for (const code of REAL_INDEXES) {
  const file = join(RELEASE_DIR, `${code}.idx.gz`);
  test(`release index ${code} matches zlib`, { skip: !existsSync(file) && `${file} missing` }, () => {
    const gz = readFileSync(file);
    const expected = gunzipSync(gz);
    const actual = gunzip(gz);
    assert.equal(actual.length, expected.length);
    assert.ok(Buffer.from(actual.buffer, actual.byteOffset, actual.length).equals(expected));
  });
}
