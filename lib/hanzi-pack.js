// Character data from Make Me a Hanzi (stroke outlines and medians,
// decomposition, radical, etymology) in one file of gzip blocks with an
// offset table, read by range like the indexes. Browser-safe: no Node APIs.
//
// Layout (little-endian):
//   "WLHANZI1"                     8 bytes
//   u32 headerBytes, header JSON   {version, count, blocks, source, license}
//   blocks x {u32 first, u32 last, u32 offset, u32 length}
//                                  first/last code point, the block's place
//   blocks                         gzip of JSON lines sorted by code point,
//                                  one record per character (packRecord)
//
//   const pack = await openHanziPack(reader, { inflate });  // reader as in lazy-index.js
//   await pack.get('好');  // -> {character, strokes, medians, decomposition, radical, ...} or null
//   await pack.tree('好'); // -> {character, record, op, children: [...]}
//
// inflate(bytes) -> Promise<string> decodes one gzip block (DecompressionStream
// or web/inflate.js in the app, zlib in Node).

export const MAGIC = 'WLHANZI1';
export const PACK_VERSION = 1;

// Ideographic description characters: the operator of a decomposition and
// how many components it takes.
export const IDC_ARITY = {
  '⿰': 2, '⿱': 2, '⿲': 3, '⿳': 3, '⿴': 2, '⿵': 2, '⿶': 2, '⿷': 2, '⿸': 2, '⿹': 2, '⿺': 2, '⿻': 2,
};

// The decomposition string of Make Me a Hanzi ("⿰女子", "？" for unknown
// parts) -> a tree {op, children} of characters; a lone character is a leaf.
export function parseDecomposition(text) {
  const chars = Array.from(text || '');
  let i = 0;
  function node() {
    const c = chars[i++];
    if (c === undefined) return null;
    const arity = IDC_ARITY[c];
    if (!arity) return { character: c };
    const children = [];
    for (let k = 0; k < arity; k++) children.push(node());
    return { op: c, children: children.filter(Boolean) };
  }
  const root = node();
  return root || null;
}

// Components named by a decomposition (unknown parts "？" left out).
export function components(text) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (n.character) { if (n.character !== '？' && !out.includes(n.character)) out.push(n.character); return; }
    n.children.forEach(walk);
  })(parseDecomposition(text));
  return out;
}

const decoder = new TextDecoder();

export class HanziPack {
  constructor(reader, header, table, inflate) {
    this.reader = reader;
    this.header = header;
    this.table = table;      // Uint32Array, 4 per block
    this.inflate = inflate;
    this.cache = new Map();  // block number -> Map(character -> record)
  }

  get count() { return this.header.count; }

  blockOf(cp) {
    const t = this.table;
    let lo = 0, hi = t.length / 4 - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cp < t[mid * 4]) hi = mid - 1;
      else if (cp > t[mid * 4 + 1]) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  async block(b) {
    let m = this.cache.get(b);
    if (m) return m;
    const t = this.table;
    const bytes = await this.reader.read(t[b * 4 + 2], t[b * 4 + 3]);
    const text = await this.inflate(bytes);
    m = new Map();
    for (const line of text.split('\n')) {
      if (!line) continue;
      const r = JSON.parse(line);
      m.set(r.character, r);
    }
    if (this.cache.size >= 16) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(b, m);
    return m;
  }

  async get(character) {
    const cp = character && character.codePointAt(0);
    if (!cp) return null;
    const b = this.blockOf(cp);
    if (b < 0) return null;
    return (await this.block(b)).get(String.fromCodePoint(cp)) || null;
  }

  // The decomposition tree of `character`, each component expanded with its
  // own decomposition down to `depth` levels: {character, record, op, children}.
  async tree(character, depth = 3) {
    const record = await this.get(character);
    const out = { character, record, op: null, children: [] };
    if (!record || depth <= 0) return out;
    const parsed = parseDecomposition(record.decomposition);
    if (!parsed || parsed.character) return out;
    const expand = async (n) => {
      if (n.character) {
        if (n.character === '？' || n.character === character) return { character: n.character, record: null, op: null, children: [] };
        return this.tree(n.character, depth - 1);
      }
      return { character: null, record: null, op: n.op, children: await Promise.all(n.children.map(expand)) };
    };
    out.op = parsed.op;
    out.children = await Promise.all(parsed.children.map(expand));
    return out;
  }
}

export async function openHanziPack(reader, { inflate }) {
  const head = await reader.read(0, 12);
  for (let i = 0; i < MAGIC.length; i++) {
    if (head[i] !== MAGIC.charCodeAt(i)) throw new Error('not a character data file');
  }
  const headerBytes = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(8, true);
  const header = JSON.parse(decoder.decode(await reader.read(12, headerBytes)));
  if (header.version !== PACK_VERSION) throw new Error(`character data version ${header.version}, expected ${PACK_VERSION}`);
  const tableBytes = await reader.read(12 + headerBytes, header.blocks * 16);
  const table = new Uint32Array(header.blocks * 4);
  const dv = new DataView(tableBytes.buffer, tableBytes.byteOffset, tableBytes.byteLength);
  for (let i = 0; i < table.length; i++) table[i] = dv.getUint32(i * 4, true);
  return new HanziPack(reader, header, table, inflate);
}
