// Reader for the word frequency lists of wordfreq
// (https://github.com/rspeer/wordfreq, data CC BY-SA 4.0, see README.md),
// used at build time only to give entries a `freq`. A list is a gzip'd
// MessagePack array: a header {format: 'cB', version: 1}, then one array of
// words per frequency bucket, bucket i holding the words of frequency
// -i centibels (i / 100 orders of magnitude below 1), so Zipf frequency =
// 9 - i / 100. Chinese words are in "oversimplified" Chinese (every
// traditional character replaced by its simplified one).
//
// Only the MessagePack types such a file uses are decoded (arrays, maps,
// strings, integers, nil, booleans); no dependency.
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

export const WORDFREQ_VERSION = 'v3.2';
export const WORDFREQ_URL = (code, size = 'large') =>
  `https://raw.githubusercontent.com/rspeer/wordfreq/${WORDFREQ_VERSION}/wordfreq/data/${size}_${code}.msgpack.gz`;
export const WORDFREQ_ATTRIBUTION = 'wordfreq by Robyn Speer (https://github.com/rspeer/wordfreq), data CC BY-SA 4.0, '
  + 'from Wikipedia, OpenSubtitles 2018, SUBTLEX (Brysbaert et al.), NewsCrawl, GlobalVoices, Google Books Ngrams, OSCAR, '
  + 'Twitter, Reddit and, for Chinese, the Jieba word list';

export function decodeMsgpack(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let pos = 0;
  const str = (n) => {
    const s = decoder.decode(bytes.subarray(pos, pos + n));
    pos += n;
    return s;
  };
  const arr = (n) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = value();
    return out;
  };
  const map = (n) => {
    const out = {};
    for (let i = 0; i < n; i++) {
      const k = value();
      out[k] = value();
    }
    return out;
  };
  function value() {
    const b = bytes[pos++];
    if (b <= 0x7f) return b;
    if (b >= 0x80 && b <= 0x8f) return map(b & 0x0f);
    if (b >= 0x90 && b <= 0x9f) return arr(b & 0x0f);
    if (b >= 0xa0 && b <= 0xbf) return str(b & 0x1f);
    if (b >= 0xe0) return b - 0x100;
    let n;
    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xcc: return bytes[pos++];
      case 0xcd: n = view.getUint16(pos); pos += 2; return n;
      case 0xce: n = view.getUint32(pos); pos += 4; return n;
      case 0xd0: n = view.getInt8(pos); pos += 1; return n;
      case 0xd1: n = view.getInt16(pos); pos += 2; return n;
      case 0xd2: n = view.getInt32(pos); pos += 4; return n;
      case 0xd9: n = bytes[pos++]; return str(n);
      case 0xda: n = view.getUint16(pos); pos += 2; return str(n);
      case 0xdb: n = view.getUint32(pos); pos += 4; return str(n);
      case 0xdc: n = view.getUint16(pos); pos += 2; return arr(n);
      case 0xdd: n = view.getUint32(pos); pos += 4; return arr(n);
      case 0xde: n = view.getUint16(pos); pos += 2; return map(n);
      case 0xdf: n = view.getUint32(pos); pos += 4; return map(n);
      default: throw new Error(`unsupported MessagePack type 0x${b.toString(16)} at ${pos - 1}`);
    }
  }
  return value();
}

// Map word -> Zipf frequency (higher = more common) from a list file.
export async function loadWordfreq(path) {
  const [header, ...buckets] = decodeMsgpack(gunzipSync(await readFile(path)));
  if (header?.format !== 'cB') throw new Error(`${path}: not a wordfreq cB list`);
  const zipf = new Map();
  buckets.forEach((words, i) => {
    for (const w of words) if (!zipf.has(w)) zipf.set(w, 9 - i / 100);
  });
  return zipf;
}
