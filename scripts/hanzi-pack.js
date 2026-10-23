#!/usr/bin/env node
// Make Me a Hanzi (graphics.txt + dictionary.txt) -> the character data file
// of lib/hanzi-pack.js.
// Usage: node scripts/hanzi-pack.js GRAPHICS DICTIONARY OUT [PER_BLOCK]
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { MAGIC, PACK_VERSION } from '../lib/hanzi-pack.js';

const PER_BLOCK = 32;

export function buildPack(graphicsText, dictionaryText, perBlock = PER_BLOCK) {
  const records = new Map();
  for (const line of dictionaryText.split('\n')) {
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    records.set(d.character, { ...d });
  }
  for (const line of graphicsText.split('\n')) {
    if (!line.trim()) continue;
    const g = JSON.parse(line);
    const r = records.get(g.character) || { character: g.character };
    r.strokes = g.strokes;
    r.medians = g.medians;
    records.set(g.character, r);
  }
  const sorted = [...records.values()].sort((a, b) => a.character.codePointAt(0) - b.character.codePointAt(0));
  const blocks = [];
  for (let i = 0; i < sorted.length; i += perBlock) {
    const part = sorted.slice(i, i + perBlock);
    const text = part.map((r) => JSON.stringify(r)).join('\n') + '\n';
    blocks.push({ first: part[0].character.codePointAt(0), last: part[part.length - 1].character.codePointAt(0), gz: gzipSync(text, { level: 9 }) });
  }
  const header = Buffer.from(JSON.stringify({
    version: PACK_VERSION,
    count: sorted.length,
    blocks: blocks.length,
    source: 'Make Me a Hanzi, https://github.com/skishore/makemeahanzi',
    license: 'stroke data (graphics.txt): Arphic Public License; dictionary data (dictionary.txt): GNU LGPL 3.0 or later',
  }));
  const tableStart = 12 + header.length;
  let offset = tableStart + blocks.length * 16;
  const table = Buffer.alloc(blocks.length * 16);
  blocks.forEach((b, i) => {
    table.writeUInt32LE(b.first, i * 16);
    table.writeUInt32LE(b.last, i * 16 + 4);
    table.writeUInt32LE(offset, i * 16 + 8);
    table.writeUInt32LE(b.gz.length, i * 16 + 12);
    offset += b.gz.length;
  });
  const lead = Buffer.alloc(12);
  lead.write(MAGIC, 0, 'latin1');
  lead.writeUInt32LE(header.length, 8);
  return { bytes: Buffer.concat([lead, header, table, ...blocks.map((b) => b.gz)]), count: sorted.length, blocks: blocks.length };
}

if (process.argv[1] === import.meta.filename) {
  const [graphics, dictionary, out, per] = process.argv.slice(2);
  if (!graphics || !dictionary || !out) {
    console.error('usage: hanzi-pack.js GRAPHICS DICTIONARY OUT [PER_BLOCK]');
    process.exit(2);
  }
  const { bytes, count, blocks } = buildPack(readFileSync(graphics, 'utf8'), readFileSync(dictionary, 'utf8'), Number(per) || PER_BLOCK);
  writeFileSync(out, bytes);
  console.log(`${out}: ${count} characters, ${blocks} blocks, ${bytes.length} bytes`);
}
