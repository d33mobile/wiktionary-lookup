// gunzip in plain JavaScript, for WebViews without DecompressionStream
// (Chromium < 80, e.g. Android 9 without WebView updates). Decodes DEFLATE
// (RFC 1951) inside the gzip container (RFC 1952); Huffman codes are decoded
// canonically from per-length counts as in zlib's puff.c, which needs no
// lookup tables and is fast enough for a one-time download.

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
  131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
  2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const MAX_BITS = 15;

class Huffman {
  constructor(lengths, n) {
    this.count = new Uint16Array(MAX_BITS + 1);
    this.symbol = new Uint16Array(n);
    for (let s = 0; s < n; s++) this.count[lengths[s]]++;
    this.count[0] = 0;
    const offs = new Uint16Array(MAX_BITS + 1);
    for (let len = 1; len < MAX_BITS; len++) offs[len + 1] = offs[len] + this.count[len];
    for (let s = 0; s < n; s++) if (lengths[s] !== 0) this.symbol[offs[lengths[s]]++] = s;
  }
}

let fixedLit = null;
let fixedDist = null;
function fixedTables() {
  if (!fixedLit) {
    const lengths = new Uint8Array(288);
    lengths.fill(8, 0, 144);
    lengths.fill(9, 144, 256);
    lengths.fill(7, 256, 280);
    lengths.fill(8, 280, 288);
    fixedLit = new Huffman(lengths, 288);
    fixedDist = new Huffman(new Uint8Array(30).fill(5), 30);
  }
}

class Inflater {
  constructor(input, pos, out) {
    this.in = input;
    this.pos = pos;
    this.bitBuf = 0;
    this.bitCount = 0;
    this.out = out;
    this.outPos = 0;
  }

  bits(need) {
    let val = this.bitBuf;
    while (this.bitCount < need) {
      if (this.pos >= this.in.length) throw new Error('inflate: unexpected end of data');
      val |= this.in[this.pos++] << this.bitCount;
      this.bitCount += 8;
    }
    this.bitBuf = val >>> need;
    this.bitCount -= need;
    return val & ((1 << need) - 1);
  }

  // Canonical decode one bit at a time (bits arrive in reversed code order).
  decode(h) {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= MAX_BITS; len++) {
      code |= this.bits(1);
      const count = h.count[len];
      if (code - count < first) return h.symbol[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('inflate: bad Huffman code');
  }

  ensure(extra) {
    if (this.outPos + extra <= this.out.length) return;
    const grown = new Uint8Array(Math.max(this.out.length * 2, this.outPos + extra));
    grown.set(this.out.subarray(0, this.outPos));
    this.out = grown;
  }

  stored() {
    this.bitBuf = 0;
    this.bitCount = 0;
    if (this.pos + 4 > this.in.length) throw new Error('inflate: unexpected end of data');
    const len = this.in[this.pos] | (this.in[this.pos + 1] << 8);
    const nlen = this.in[this.pos + 2] | (this.in[this.pos + 3] << 8);
    if (len !== (~nlen & 0xFFFF)) throw new Error('inflate: bad stored block length');
    this.pos += 4;
    if (this.pos + len > this.in.length) throw new Error('inflate: unexpected end of data');
    this.ensure(len);
    this.out.set(this.in.subarray(this.pos, this.pos + len), this.outPos);
    this.pos += len;
    this.outPos += len;
  }

  codes(lit, dist) {
    for (;;) {
      let sym = this.decode(lit);
      if (sym < 256) {
        if (this.outPos >= this.out.length) this.ensure(1);
        this.out[this.outPos++] = sym;
      } else if (sym === 256) {
        return;
      } else {
        sym -= 257;
        if (sym >= 29) throw new Error('inflate: bad length symbol');
        const len = LENGTH_BASE[sym] + this.bits(LENGTH_EXTRA[sym]);
        const dsym = this.decode(dist);
        if (dsym >= 30) throw new Error('inflate: bad distance symbol');
        const d = DIST_BASE[dsym] + this.bits(DIST_EXTRA[dsym]);
        if (d > this.outPos) throw new Error('inflate: distance too far back');
        this.ensure(len);
        const out = this.out;
        let o = this.outPos;
        for (let k = 0; k < len; k++, o++) out[o] = out[o - d];
        this.outPos = o;
      }
    }
  }

  dynamic() {
    const nlen = this.bits(5) + 257;
    const ndist = this.bits(5) + 1;
    const ncode = this.bits(4) + 4;
    if (nlen > 286 || ndist > 30) throw new Error('inflate: bad dynamic block counts');
    const lengths = new Uint8Array(320);
    for (let i = 0; i < ncode; i++) lengths[CODE_LENGTH_ORDER[i]] = this.bits(3);
    const lencode = new Huffman(lengths, 19);
    lengths.fill(0);
    let i = 0;
    while (i < nlen + ndist) {
      const sym = this.decode(lencode);
      if (sym < 16) {
        lengths[i++] = sym;
        continue;
      }
      let len = 0;
      let repeat;
      if (sym === 16) {
        if (i === 0) throw new Error('inflate: repeat with no previous length');
        len = lengths[i - 1];
        repeat = 3 + this.bits(2);
      } else if (sym === 17) {
        repeat = 3 + this.bits(3);
      } else {
        repeat = 11 + this.bits(7);
      }
      if (i + repeat > nlen + ndist) throw new Error('inflate: too many lengths');
      while (repeat--) lengths[i++] = len;
    }
    if (lengths[256] === 0) throw new Error('inflate: no end-of-block code');
    this.codes(new Huffman(lengths, nlen), new Huffman(lengths.subarray(nlen), ndist));
  }

  run() {
    let last;
    do {
      last = this.bits(1);
      const type = this.bits(2);
      if (type === 0) this.stored();
      else if (type === 1) {
        fixedTables();
        this.codes(fixedLit, fixedDist);
      } else if (type === 2) this.dynamic();
      else throw new Error('inflate: bad block type');
    } while (!last);
    this.bitBuf = 0;
    this.bitCount = 0;
  }
}

// Concatenated gzip members are decoded one after another, as gzip -d does.
// sizeHint (the expected output size) avoids growing the output buffer.
export function gunzip(input, sizeHint) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  let size = sizeHint;
  if (!size && data.length >= 4) {
    const n = data.length;
    size = (data[n - 4] | (data[n - 3] << 8) | (data[n - 2] << 16) | (data[n - 1] << 24)) >>> 0;
  }
  let out = new Uint8Array(size || data.length * 4);
  let outPos = 0;
  let pos = 0;
  while (pos < data.length) {
    if (data[pos] !== 0x1F || data[pos + 1] !== 0x8B || data[pos + 2] !== 8) throw new Error('gunzip: not gzip data');
    const flags = data[pos + 3];
    pos += 10;
    if (flags & 4) pos += 2 + (data[pos] | (data[pos + 1] << 8));
    if (flags & 8) while (data[pos++] !== 0);
    if (flags & 16) while (data[pos++] !== 0);
    if (flags & 2) pos += 2;
    const inflater = new Inflater(data, pos, out);
    inflater.outPos = outPos;
    inflater.run();
    out = inflater.out;
    const memberSize = inflater.outPos - outPos;
    pos = inflater.pos;
    const isize = (data[pos + 4] | (data[pos + 5] << 8) | (data[pos + 6] << 16) | (data[pos + 7] << 24)) >>> 0;
    if (isize !== memberSize % 0x100000000) throw new Error('gunzip: size mismatch');
    pos += 8;
    outPos = inflater.outPos;
  }
  return out.length === outPos ? out : out.slice(0, outPos);
}
