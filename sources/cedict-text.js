// Source plugin: CC-CEDICT text export (cedict_1_0_ts_utf-8_mdbg.txt).
// Line format: TRAD SIMP [PINYIN] /sense 1/sense 2/
// Every source exports `async function* entries(path)` yielding
// {simp, trad, pinyin, definition}; pinyin is space-separated syllables with
// tone digits, definition senses are joined with "/".
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const LINE_RE = /^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/;

export function parseLine(line) {
  if (line.startsWith('#')) return null;
  const m = LINE_RE.exec(line);
  if (!m) return null;
  return {
    trad: m[1],
    simp: m[2],
    pinyin: m[3].replace(/u:/g, 'ü').replace(/U:/g, 'Ü'),
    definition: m[4],
  };
}

export async function* entries(path) {
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const entry = parseLine(line);
    if (entry) yield entry;
  }
}
