#!/usr/bin/env node
// Gzips Wikipedia title indexes for the data release and writes the
// manifest fragment that lists them next to the Wiktionary languages:
//
//   node scripts/wikipedia-release.js OUTDIR INDEX...
//
// Per index (built by sources/wikipedia-titles.js): OUTDIR/wikipedia-<code>.idx.gz
// and an entry
//   {kind: 'wikipedia', code, name, entries, bytes, sha256, gzBytes, url,
//    articleUrl, script, hasRomanization, textOffsets, source}
// (bytes and sha256 of the uncompressed index, url relative to the
// manifest); OUTDIR/manifest-wikipedia.json = {generated, license,
// wikipedia: [entries]}. Wiktionary entries of the main manifest are the
// same shape with kind 'wiktionary' (and details).
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createGzip, constants as zlib } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LICENSE = 'Wikipedia titles and short descriptions: CC BY-SA 4.0, by the Wikipedia contributors; '
  + 'clickstream (ranking): CC0, Wikimedia Foundation';

export async function readHeader(path) {
  const fh = await open(path, 'r');
  try {
    const head = Buffer.alloc(12);
    await fh.read(head, 0, 12, 0);
    const len = head.readUInt32LE(8);
    const json = Buffer.alloc(len);
    await fh.read(json, 0, len, 12);
    return JSON.parse(json.toString('utf8'));
  } finally {
    await fh.close();
  }
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function releaseEntry(path, outDir) {
  const header = await readHeader(path);
  const offsets = header.sections.find((s) => s.name === 'fieldOffsets');
  const { code, name, script, hasRomanization } = header.language;
  const file = `wikipedia-${code}.idx.gz`;
  await pipeline(createReadStream(path), createGzip({ level: zlib.Z_BEST_COMPRESSION }), createWriteStream(join(outDir, file)));
  return {
    kind: 'wikipedia',
    code,
    name: `${name} Wikipedia`,
    entries: (offsets.length - 1) / 4,
    bytes: (await stat(path)).size,
    sha256: await sha256(path),
    gzBytes: (await stat(join(outDir, file))).size,
    url: file,
    articleUrl: header.entryUrl,
    script,
    hasRomanization,
    textOffsets: header.textOffsets || 'units',
    source: header.source,
  };
}

async function main([outDir, ...paths]) {
  if (!outDir || paths.length === 0) {
    console.error('usage: wikipedia-release.js OUTDIR INDEX...');
    process.exit(2);
  }
  await mkdir(outDir, { recursive: true });
  const wikipedia = [];
  for (const path of paths) {
    const t0 = performance.now();
    const entry = await releaseEntry(path, outDir);
    wikipedia.push(entry);
    console.log(`${entry.url}: ${entry.entries} entries, ${entry.bytes} bytes, ${entry.gzBytes} gz, ${(performance.now() - t0).toFixed(0)} ms`);
  }
  wikipedia.sort((a, b) => a.name.localeCompare(b.name));
  const manifest = { generated: new Date().toISOString(), license: LICENSE, wikipedia };
  await writeFile(join(outDir, 'manifest-wikipedia.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`wrote ${join(outDir, 'manifest-wikipedia.json')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
}
