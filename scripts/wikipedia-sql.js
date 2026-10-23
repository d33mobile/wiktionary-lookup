// Streaming reader for MediaWiki SQL dumps (page.sql.gz, redirect.sql.gz,
// page_props.sql.gz from dumps.wikimedia.org): yields one array of column
// values per row without loading the dump into a database.
//
//   for await (const row of sqlRows('enwiki-latest-page.sql.gz', ['page_id', 'page_title'])) ...
//
// The dump is mysqldump output: a CREATE TABLE block naming the columns,
// then INSERT statements holding comma-separated tuples, either all on the
// statement's line (mysqldump) or one tuple per line after "VALUES"
// (MariaDB dumps since 2025). Strings are single-quoted with backslash
// escapes and never contain a raw newline, so the file is read line by line. Numbers
// come back as numbers, NULL as null, strings as strings (the bytes are
// UTF-8). Only the requested columns are decoded; a row is an array in the
// order of `columns`.
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

const ESCAPES = { 0: '\0', n: '\n', r: '\r', t: '\t', Z: '\x1a', b: '\b' };
const COLUMN_RE = /^\s+`([^`]+)`/;
const QUOTE = 39; // '
const BACKSLASH = 92;
const OPEN = 40; // (
const CLOSE = 41; // )
const COMMA = 44;

// Parses the tuples of `line` from `pos` on; calls onRow(values) with the
// values of the wanted columns (wanted[i] = output position of column i, or
// -1).
export function parseTuples(line, pos, wanted, width, onRow) {
  const n = line.length;
  while (pos < n) {
    while (pos < n && line.charCodeAt(pos) !== OPEN) pos++;
    if (pos >= n) return;
    pos++;
    const row = new Array(width);
    for (let col = 0; ; col++) {
      const want = col < wanted.length ? wanted[col] : -1;
      let value;
      if (line.charCodeAt(pos) === QUOTE) {
        pos++;
        let out = '';
        for (;;) {
          const q = line.indexOf("'", pos);
          const b = line.indexOf('\\', pos);
          if (q < 0) throw new Error('unterminated string in INSERT line');
          if (b >= 0 && b < q) {
            if (want >= 0) {
              const c = line[b + 1];
              out += line.slice(pos, b) + (ESCAPES[c] ?? c);
            }
            pos = b + 2;
          } else {
            if (want >= 0) out += line.slice(pos, q);
            pos = q + 1;
            break;
          }
        }
        value = out;
      } else {
        const start = pos;
        while (pos < n) {
          const c = line.charCodeAt(pos);
          if (c === COMMA || c === CLOSE) break;
          pos++;
        }
        if (want >= 0) {
          const raw = line.slice(start, pos);
          value = raw === 'NULL' ? null : Number(raw);
        }
      }
      if (want >= 0) row[want] = value;
      const c = line.charCodeAt(pos);
      pos++;
      if (c === CLOSE) break;
      if (c !== COMMA) throw new Error(`unexpected ${line[pos - 1]} after column ${col}`);
    }
    onRow(row);
    // Skip the "," or ";" between tuples.
    pos++;
  }
}

// Async generator of rows (arrays of the `columns` values). A file name
// ending in .gz is decompressed on the fly.
export async function* sqlRows(path, columns) {
  let input = createReadStream(path, { highWaterMark: 1 << 20 });
  if (path.endsWith('.gz')) input = input.pipe(createGunzip({ chunkSize: 1 << 20 }));
  const lines = createInterface({ input, crlfDelay: Infinity });
  let names = null;
  let inCreate = false;
  let wanted = null;
  let inValues = false;
  for await (const line of lines) {
    if (line.startsWith('CREATE TABLE')) {
      inCreate = true;
      names = [];
      continue;
    }
    if (inCreate) {
      const m = line.match(COLUMN_RE);
      if (m) names.push(m[1]);
      else if (line.startsWith(')')) {
        inCreate = false;
        const missing = columns.filter((c) => !names.includes(c));
        if (missing.length) throw new Error(`${path}: no column ${missing.join(', ')} (has ${names.join(', ')})`);
        wanted = names.map((name) => columns.indexOf(name));
      }
      continue;
    }
    let pos = 0;
    if (line.startsWith('INSERT INTO')) {
      if (!wanted) throw new Error(`${path}: INSERT before CREATE TABLE`);
      inValues = true;
      pos = line.indexOf(' VALUES') + 7;
    } else if (!inValues) {
      continue;
    }
    const rows = [];
    parseTuples(line, pos, wanted, columns.length, (row) => rows.push(row));
    if (line.endsWith(';')) inValues = false;
    yield* rows;
  }
}
