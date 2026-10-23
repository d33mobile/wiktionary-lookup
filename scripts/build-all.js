#!/usr/bin/env node
// Builds one index per language listed in data/languages.json
// (scripts/kaikki-languages.js list) and writes manifest.json.
//
//   node scripts/build-all.js [--out DIR] [--work DIR] [--only CODE,...] [--keep-jsonl]
//                             [--min-entries N] [--retry-failed] [--manifest-only] [--force]
//                             [--wordfreq-dir DIR] [--wordfreq-langs CODE,...]
//
// Per language, one at a time: download <work>/<code>.jsonl (sequentially;
// compressed transfer), build <out>/<code>.idx in a child process (Chinese
// with the wiktionary-zh source, everything else with the generic one), gzip
// it to <out>/<code>.idx.gz and record {code, name, entries, bytes, sha256,
// gzBytes, url, script, hasRomanization, buildMs} in <out>/meta/<code>.json.
// The JSONL is deleted afterwards when it is larger than KEEP_JSONL_BYTES,
// except for Chinese. A language with fewer than --min-entries entries (50)
// is recorded as skipped and gets no index.
//
// Frequency: for the languages in --wordfreq-langs (default: zh) the wordfreq
// list large_<code>.msgpack.gz (lib/wordfreq.js, CC BY-SA 4.0) is downloaded
// to --wordfreq-dir once and passed to the source, which ranks entries by it.
//
// Resumable: a language whose meta file has the current BUILD_REV and the
// listed extract size is done and not rebuilt (--force rebuilds anyway);
// failures
// are recorded in <out>/meta/<code>.failed.json and retried only with
// --retry-failed. Progress goes to stdout and <out>/build-all.log. The
// manifest is rewritten from the meta files after every language (kind
// 'wiktionary') plus the entries of <out>/manifest-wikipedia.json when it
// exists (kind 'wikipedia', scripts/wikipedia-release.js), sorted by
// name, with url = "<code>.idx.gz" (relative to the manifest, as the data
// release serves both from the same directory).
import { readFile, writeFile, mkdir, rm, stat, readdir, rename, appendFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGzip, constants as zlibConstants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { download, LANGUAGES_JSON } from './kaikki-languages.js';
import { WORDFREQ_URL } from '../lib/wordfreq.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEFAULTS = {
  out: '/mnt/biglinks/wiktionary/idx',
  work: '/mnt/biglinks/wiktionary/kaikki',
  minEntries: 50,
  wordfreqDir: '/mnt/biglinks/wiktionary/freq/wordfreq',
  wordfreqLangs: new Set(['zh']),
};
const KEEP_JSONL_BYTES = 100e6;
const WIKIPEDIA_FRAGMENT = 'manifest-wikipedia.json';
const KEEP_JSONL_CODES = new Set(['zh']);
const CHILD_HEAP_MB = 12000;
// Bumped whenever the index contents change (sources, builder, format); a
// language whose meta file has another revision or another extract size is
// rebuilt. 2: frequencies (zh) and pronunciation audio. 3: details
// embedded. 4: details in a sidecar file; a revision 3 index of the same
// extract is split into index and sidecar instead of rebuilt. 5: entries
// sorted by headword key, byte text offsets (lazy opening).
const BUILD_REV = 5;
const SPLITTABLE_REV = 3;

function parseArgs(argv) {
  const opts = { ...DEFAULTS, only: null, keepJsonl: false, retryFailed: false, manifestOnly: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--work') opts.work = argv[++i];
    else if (a === '--only') opts.only = new Set(argv[++i].split(','));
    else if (a === '--min-entries') opts.minEntries = Number(argv[++i]);
    else if (a === '--keep-jsonl') opts.keepJsonl = true;
    else if (a === '--retry-failed') opts.retryFailed = true;
    else if (a === '--manifest-only') opts.manifestOnly = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--wordfreq-dir') opts.wordfreqDir = argv[++i];
    else if (a === '--wordfreq-langs') opts.wordfreqLangs = new Set(argv[++i].split(',').filter(Boolean));
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

const exists = (path) => stat(path).then(() => true, () => false);

async function sha256(path) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest('hex');
}

async function gzip(src, dest) {
  await pipeline(createReadStream(src), createGzip({ level: zlibConstants.Z_BEST_COMPRESSION }), createWriteStream(`${dest}.part`));
  await rename(`${dest}.part`, dest);
}

// Builds in a child so that a language that exhausts memory fails alone.
function buildInChild(code, name, jsonl, out, source, wordfreq) {
  return runChild(['--worker', code, name, jsonl, out, JSON.stringify(source), wordfreq ?? '']);
}

function runChild(workerArgs) {
  return new Promise((resolvePromise, reject) => {
    const args = [`--max-old-space-size=${CHILD_HEAP_MB}`, fileURLToPath(import.meta.url), ...workerArgs];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status, signal) => {
      if (status === 0) resolvePromise(JSON.parse(stdout.trim().split('\n').pop()));
      else reject(new Error(`build exited with ${signal ?? status}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

// Writes the parts of an index and its details sidecar: <out>.part and
// <sidecar>.part (renamed by finish()). -> {entries, audioEntries, detailsEntries}.
async function writeParts(sections, info, out) {
  const { splitDetails, detailsPath } = await import(pathToFileURL(join(ROOT, 'build-index.js')).href);
  const { serializeIndex } = await import(pathToFileURL(join(ROOT, 'lib', 'index-format.js')).href);
  const { base, details } = splitDetails(sections, info);
  await writeFile(`${out}.part`, serializeIndex(base.sections, base.meta));
  if (details) await writeFile(`${detailsPath(out)}.part`, serializeIndex(details.sections, details.meta));
  return {
    entries: sections.rank.length,
    audioEntries: sections.audioEntries ? sections.audioEntries.length : 0,
    detailsEntries: details ? details.meta.details.entries : 0,
  };
}

// Child process: split an index with embedded details (build revision 3)
// into base index and sidecar without rebuilding it.
async function splitWorker([out]) {
  const { deserializeIndexWithHeader } = await import(pathToFileURL(join(ROOT, 'lib', 'index-format.js')).href);
  const { header, sections } = deserializeIndexWithHeader(await readFile(out));
  const { version, sections: descriptors, ...meta } = header;
  if (meta.details && meta.details.entries === undefined) {
    // Revision 3 did not count the entries with details: count them.
    const { gunzipSync } = await import('node:zlib');
    const data = new Uint8Array(sections.detailsData.buffer, sections.detailsData.byteOffset);
    let n = 0;
    for (let b = 0; b < sections.detailsBlockBytes.length; b++) {
      const start = sections.detailsBlockStart[b] * 4;
      for (const x of JSON.parse(gunzipSync(data.subarray(start, start + sections.detailsBlockBytes[b])).toString())) if (x) n++;
    }
    meta.details = { ...meta.details, entries: n };
  }
  const counts = await writeParts(sections, meta, out);
  console.log(JSON.stringify({ ...counts, language: header.language }));
}

// Child process: build one index, print {entries, language} as JSON.
async function worker([code, name, jsonl, out, sourceJson, wordfreq]) {
  const { buildIndex } = await import(pathToFileURL(join(ROOT, 'build-index.js')).href);
  const source = await import(pathToFileURL(join(ROOT, 'sources', code === 'zh' ? 'wiktionary-zh.js' : 'wiktionary.js')).href);
  const info = {};
  const sections = await buildIndex(source.entries(jsonl, info, wordfreq ? { wordfreq } : {}), info);
  // The list's code and name are the catalogue's; the source keeps the rest.
  info.language = { ...info.language, code, name };
  info.source = { ...info.source, ...JSON.parse(sourceJson) };
  const counts = sections.rank.length > 0 ? await writeParts(sections, info, out) : { entries: 0, audioEntries: 0, detailsEntries: 0 };
  console.log(JSON.stringify({ ...counts, language: info.language }));
}

const detailsFile = (idx) => `${idx.slice(0, -4)}.details`;

// Moves the parts in place, gzips them and writes the language's meta file.
async function finish(lang, idx, built, buildMs, extra = {}) {
  await rename(`${idx}.part`, idx);
  await gzip(idx, `${idx}.gz`);
  const side = detailsFile(idx);
  let details = null;
  if (await exists(`${side}.part`)) {
    await rename(`${side}.part`, side);
    await gzip(side, `${side}.gz`);
    details = {
      url: `${lang.code}.details.gz`,
      bytes: (await stat(side)).size,
      sha256: await sha256(side),
      gzBytes: (await stat(`${side}.gz`)).size,
      entries: built.detailsEntries,
    };
  } else {
    await rm(side, { force: true });
    await rm(`${side}.gz`, { force: true });
  }
  const meta = {
    code: lang.code,
    name: lang.name,
    entries: built.entries,
    audioEntries: built.audioEntries,
    bytes: (await stat(idx)).size,
    sha256: await sha256(idx),
    gzBytes: (await stat(`${idx}.gz`)).size,
    url: `${lang.code}.idx.gz`,
    details,
    script: built.language.script,
    hasRomanization: built.language.hasRomanization,
    jsonlBytes: lang.bytes,
    buildRev: BUILD_REV,
    buildMs,
    ...extra,
  };
  await writeFile(join(dirname(idx), 'meta', `${lang.code}.json`), `${JSON.stringify(meta)}\n`);
  return meta;
}

async function writeManifest(opts, list) {
  const metaDir = join(opts.out, 'meta');
  const languages = [];
  for (const f of (await readdir(metaDir)).filter((n) => n.endsWith('.json') && !n.endsWith('.failed.json'))) {
    const m = JSON.parse(await readFile(join(metaDir, f), 'utf8'));
    if (m.skipped) continue;
    const { code, name, entries, audioEntries, bytes, sha256: sum, gzBytes, url, details, script, hasRomanization } = m;
    languages.push({
      kind: 'wiktionary', code, name, entries, audioEntries, bytes, sha256: sum, gzBytes, url, ...(details ? { details } : {}), script, hasRomanization,
    });
  }
  // Wikipedia title indexes (scripts/wikipedia-release.js) published next
  // to the Wiktionary ones: kind 'wikipedia'.
  try {
    languages.push(...JSON.parse(await readFile(join(opts.out, WIKIPEDIA_FRAGMENT), 'utf8')).wikipedia);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  languages.sort((a, b) => a.name.localeCompare(b.name));
  const manifest = {
    generated: new Date().toISOString(),
    source: { name: 'English Wiktionary via kaikki.org (wiktextract)', url: 'https://kaikki.org/dictionary/', extracted: list.extracted, dumpDate: list.dumpDate },
    license: 'Wiktionary text: CC BY-SA 4.0 and GFDL, by the Wiktionary contributors',
    languages,
  };
  await writeFile(join(opts.out, 'manifest.json.part'), `${JSON.stringify(manifest, null, 1)}\n`);
  await rename(join(opts.out, 'manifest.json.part'), join(opts.out, 'manifest.json'));
  return manifest;
}

async function main(argv) {
  if (argv[0] === '--worker') return worker(argv.slice(1));
  if (argv[0] === '--split-worker') return splitWorker(argv.slice(1));
  const opts = parseArgs(argv);
  const list = JSON.parse(await readFile(LANGUAGES_JSON, 'utf8'));
  const metaDir = join(opts.out, 'meta');
  await mkdir(metaDir, { recursive: true });
  await mkdir(opts.work, { recursive: true });
  const logFile = join(opts.out, 'build-all.log');
  const log = async (msg) => {
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(line);
    await appendFile(logFile, `${line}\n`);
  };
  if (opts.manifestOnly) {
    const m = await writeManifest(opts, list);
    return log(`manifest: ${m.languages.length} languages`);
  }
  const todo = list.languages.filter((l) => l.url && (!opts.only || opts.only.has(l.code)));
  const source = { extracted: list.extracted, dumpDate: list.dumpDate };
  const t0 = Date.now();
  await log(`start: ${todo.length} languages, out ${opts.out}, work ${opts.work}`);
  let n = 0;
  for (const lang of todo) {
    n++;
    const tag = `[${n}/${todo.length}] ${lang.code} (${lang.name}, ${(lang.bytes / 1e6).toFixed(0)} MB)`;
    const metaPath = join(metaDir, `${lang.code}.json`);
    const failedPath = join(metaDir, `${lang.code}.failed.json`);
    let splitOnly = false;
    if (await exists(metaPath) && !opts.force) {
      const done = JSON.parse(await readFile(metaPath, 'utf8'));
      if (done.jsonlBytes === lang.bytes && done.buildRev === BUILD_REV) continue;
      // Revision 3 indexes hold the same data with embedded details.
      splitOnly = done.jsonlBytes === lang.bytes && done.buildRev === SPLITTABLE_REV
        && !done.skipped && await exists(join(opts.out, `${lang.code}.idx`));
    }
    if (!opts.retryFailed && await exists(failedPath)) {
      await log(`${tag}: failed before, skipped (--retry-failed retries)`);
      continue;
    }
    const jsonl = join(opts.work, `${lang.code}.jsonl`);
    const idx = join(opts.out, `${lang.code}.idx`);
    const started = Date.now();
    try {
      if (splitOnly) {
        const built = await runChild(['--split-worker', idx]);
        const meta = await finish(lang, idx, built, Date.now() - started, { split: true });
        await rm(failedPath, { force: true });
        await log(`${tag}: split: index ${(meta.bytes / 1048576).toFixed(1)} MiB, details ${((meta.details?.bytes ?? 0) / 1048576).toFixed(1)} MiB, ${((Date.now() - started) / 1000).toFixed(1)} s`);
        await writeManifest(opts, list);
        continue;
      }
      await download(lang.url, jsonl, lang.bytes);
      let wordfreq = null;
      if (opts.wordfreqLangs.has(lang.code)) {
        wordfreq = join(opts.wordfreqDir, `large_${lang.code}.msgpack.gz`);
        if (!await exists(wordfreq)) await download(WORDFREQ_URL(lang.code), wordfreq);
      }
      const built = await buildInChild(lang.code, lang.name, jsonl, idx, { ...source, url: lang.url }, wordfreq);
      const buildMs = Date.now() - started;
      if (built.entries < opts.minEntries) {
        await rm(`${idx}.part`, { force: true });
        await writeFile(metaPath, `${JSON.stringify({ code: lang.code, name: lang.name, entries: built.entries, skipped: `fewer than ${opts.minEntries} entries`, jsonlBytes: lang.bytes, buildRev: BUILD_REV, buildMs })}\n`);
        await log(`${tag}: ${built.entries} entries, skipped`);
      } else {
        const meta = await finish(lang, idx, built, buildMs);
        await rm(failedPath, { force: true });
        await log(`${tag}: ${meta.entries} entries (${meta.audioEntries} with audio), ${(meta.bytes / 1048576).toFixed(1)} MiB (gz ${(meta.gzBytes / 1048576).toFixed(1)} MiB), ${(buildMs / 1000).toFixed(1)} s`);
      }
      if (!opts.keepJsonl && !KEEP_JSONL_CODES.has(lang.code) && lang.bytes > KEEP_JSONL_BYTES) await rm(jsonl, { force: true });
    } catch (err) {
      await rm(`${idx}.part`, { force: true });
      await rm(`${detailsFile(idx)}.part`, { force: true });
      await writeFile(failedPath, `${JSON.stringify({ code: lang.code, name: lang.name, error: err.message, at: new Date().toISOString() })}\n`);
      await log(`${tag}: FAILED ${err.message}`);
    }
    await writeManifest(opts, list);
  }
  const manifest = await writeManifest(opts, list);
  const failed = (await readdir(metaDir)).filter((f) => f.endsWith('.failed.json')).length;
  const total = manifest.languages.reduce((s, l) => s + l.bytes, 0);
  await log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${manifest.languages.length} indexes, ${failed} failed, ${(total / 1e9).toFixed(2)} GB`);
}

main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
