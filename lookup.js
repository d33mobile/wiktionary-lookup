// Node entry point of the lookup engine (lib/engine.js): loads an index file
// from disk and doubles as a one-shot CLI.
//
//   const d = await loadIndex('cedict.idx');
//   d.search('nihao', { limit: 20 })  // -> [{simp, trad, pinyin, definition, matchedOn}]
import { readFile, open } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { openSync, readSync, closeSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openIndex, Dictionary, DEFAULT_LIMIT } from './lib/engine.js';
import { openIndexReader } from './lib/index-format.js';

export { Dictionary, Session, openIndex, AUDIO_URL_PREFIX } from './lib/engine.js';
export { openIndexLazy, openIndexProgressive, fetchRangeReader } from './lib/lazy-index.js';

// Asynchronous reader over a file for lib/lazy-index.js:
// {size, read(offset, length) -> Promise<Uint8Array>, close()}.
export async function nodeFileReader(path) {
  const handle = await open(path, 'r');
  const { size } = await handle.stat();
  return {
    size,
    async read(offset, length) {
      const buf = new Uint8Array(length);
      for (let done = 0; done < length;) {
        const { bytesRead } = await handle.read(buf, done, length - done, offset + done);
        if (bytesRead === 0) throw new Error(`${path}: short read at ${offset + done}`);
        done += bytesRead;
      }
      return buf;
    },
    close: () => handle.close(),
  };
}

// Details blocks (Dictionary.getDetails) are inflated with zlib in Node.
const nodeInflate = async (bytes) => gunzipSync(bytes).toString('utf8');

// The details sidecar of INDEX.idx is INDEX.details next to it.
export function detailsPathOf(path) {
  return path.endsWith('.idx') ? `${path.slice(0, -4)}.details` : `${path}.details`;
}

// options.details: path of the details sidecar; default: detailsPathOf(path)
// when that file exists; false: none.
function sidecarPath(path, options) {
  if (options.details === false) return null;
  if (typeof options.details === 'string') return options.details;
  const guess = detailsPathOf(path);
  return existsSync(guess) ? guess : null;
}

export async function loadIndex(path, options = {}) {
  const side = sidecarPath(path, options);
  const d = openIndex(await readFile(path), { details: side ? await readFile(side) : null });
  d.inflate = nodeInflate;
  return d;
}

// Opens an index without reading it whole (lib/index-format.js
// openIndexReader): the arrays a search scans are read into memory, the
// rest is read by byte range when a search or an entry needs it. Pays off
// for an index with textOffsets 'bytes' (Wikipedia titles); call close()
// on the result when done. `options` go to openIndexReader.
export function openIndexFile(path, options = {}) {
  const fd = openSync(path, 'r');
  const read = rangeReader(fd, path);
  let sideFd = null;
  try {
    const { header, sections } = openIndexReader(read, options);
    const d = new Dictionary(sections, header);
    d.inflate = nodeInflate;
    const side = sidecarPath(path, options);
    if (side) {
      sideFd = openSync(side, 'r');
      const s = openIndexReader(rangeReader(sideFd, side), { resident: /^detailsBlock/ });
      d.attachDetails(s.sections, s.header);
    }
    d.close = () => {
      closeSync(fd);
      if (sideFd !== null) closeSync(sideFd);
    };
    return d;
  } catch (err) {
    closeSync(fd);
    if (sideFd !== null) closeSync(sideFd);
    throw err;
  }
}

function rangeReader(fd, path) {
  return (offset, length) => {
    const buf = new Uint8Array(length);
    for (let done = 0; done < length;) {
      const n = readSync(fd, buf, done, length - done, offset + done);
      if (n === 0) throw new Error(`${path}: short read at ${offset + done}`);
      done += n;
    }
    return buf;
  };
}

async function main(argv) {
  const lazy = argv.indexOf('--lazy');
  if (lazy >= 0) argv.splice(lazy, 1);
  if (argv.length < 2) {
    console.error('usage: lookup.js [--lazy] INDEX QUERY [LIMIT]');
    process.exit(2);
  }
  const d = lazy >= 0 ? openIndexFile(argv[0]) : await loadIndex(argv[0]);
  for (const row of d.search(argv[1], { limit: Number(argv[2] ?? DEFAULT_LIMIT) })) {
    const trad = row.trad === row.simp || row.trad === '' ? '' : ` (${row.trad})`;
    const audio = row.audio.length ? `\t{${row.audio.join(', ')}}` : '';
    const url = row.url ? `\t${row.url}` : '';
    console.log(`${row.simp}${trad}\t[${row.pinyin}]\t${row.definition}\t<${row.matchedOn}>${audio}${url}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
}
