#!/usr/bin/env node
// Rewrites an index with code-unit text offsets as one with byte offsets
// (header textOffsets 'bytes', lib/index-format.js), which lib/lazy-index.js
// openIndexLazy can read without decoding its text whole:
//
//   node --max-old-space-size=4096 scripts/index-byte-offsets.js IN OUT
//
// Same entries, keys and search results; only the *Offsets sections change.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { deserializeIndexWithHeader, serializeIndex } from '../lib/index-format.js';
import { byteOffsets, TEXT_TABLES } from '../build-index.js';

export function toByteOffsets(bytes) {
  const { header, sections } = deserializeIndexWithHeader(bytes);
  if (header.textOffsets === 'bytes') return null;
  for (const [blob, offsets] of TEXT_TABLES) {
    if (sections[blob] !== undefined) sections[offsets] = byteOffsets(sections[blob], sections[offsets]);
  }
  const { version, sections: _descriptors, ...meta } = header;
  return serializeIndex(sections, { ...meta, textOffsets: 'bytes' });
}

async function main([input, output]) {
  if (!output) {
    console.error('usage: index-byte-offsets.js IN OUT');
    process.exit(2);
  }
  const t0 = performance.now();
  const out = toByteOffsets(await readFile(input));
  if (!out) {
    console.error(`${input} has byte offsets already`);
    process.exit(1);
  }
  await writeFile(output, out);
  console.log(`wrote ${output} (${(out.length / 1048576).toFixed(1)} MiB) in ${(performance.now() - t0).toFixed(0)} ms`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
}
