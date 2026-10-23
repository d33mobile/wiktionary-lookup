#!/usr/bin/env node
// Usage: node tui.js [--lazy] INDEX
// Interactive lookup: type to filter, Backspace to delete, Up/Down to move
// the selection, Enter to show the full entry, Esc or Ctrl-C to quit. An
// entry with a page (Wikipedia) shows its URL; "o" opens it in the browser.
// --lazy opens the index by byte range (lookup.js openIndexFile).
import { emitKeypressEvents } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { loadIndex, openIndexFile } from './lookup.js';
import { hasCjk } from './lib/normalize.js';

const CLEAR = '\x1b[2J\x1b[H';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const INVERT = '\x1b[7m';
const RESET = '\x1b[0m';
const RESERVED_ROWS = 4;
const MIN_PREVIEW_ROWS = 5;

// Terminal columns taken by text, counting CJK characters as double width.
function displayWidth(text) {
  let w = 0;
  for (const ch of text) w += hasCjk(ch) ? 2 : 1;
  return w;
}

function fit(text, columns) {
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = hasCjk(ch) ? 2 : 1;
    if (w + cw > columns - 1) return `${out}~`;
    out += ch;
    w += cw;
  }
  return out;
}

function formatRow(row) {
  const trad = row.trad === row.simp || row.trad === '' ? '' : ` (${row.trad})`;
  const pinyin = row.pinyin === '' ? '' : `  [${row.pinyin}]`;
  return `${row.simp}${trad}${pinyin}  ${row.definition.replaceAll('/', ' / ')}`;
}

// Opens a URL in the desktop browser, detached.
function openUrl(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(command, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

class Tui {
  constructor(dict, out) {
    this.dict = dict;
    this.session = dict.newSession();
    this.out = out;
    this.query = '';
    this.rows = [];
    this.selected = 0;
    this.lastMs = 0;
    this.detail = null;
  }

  previewRows() {
    return Math.max(MIN_PREVIEW_ROWS, (this.out.rows || 24) - RESERVED_ROWS);
  }

  runSearch() {
    const t0 = performance.now();
    this.rows = this.session.search(this.query, { limit: this.previewRows() });
    this.lastMs = performance.now() - t0;
    this.selected = Math.min(this.selected, Math.max(0, this.rows.length - 1));
  }

  render() {
    const columns = this.out.columns || 80;
    const lines = [];
    if (this.detail) {
      const e = this.detail;
      const trad = e.trad === '' ? '' : `  ${e.trad}`;
      const pinyin = e.pinyin === '' ? '' : `  [${e.pinyin}]`;
      lines.push(`${BOLD}${e.simp}${RESET}${trad}${pinyin}`, '');
      for (const sense of e.definition.split('/')) lines.push(`  - ${sense}`);
      if (e.url) lines.push('', `  ${e.url}`);
      const keys = e.url ? '"o" opens the page, any other key returns to the list' : 'Any key returns to the list';
      lines.push('', `${DIM}matched on ${e.matchedOn}, entry #${e.id}. ${keys}.${RESET}`);
    } else {
      lines.push(`${BOLD}> ${this.query}${RESET}_`);
      this.rows.forEach((row, i) => {
        const text = fit(formatRow(row), columns - 2);
        lines.push(i === this.selected ? `${INVERT} ${text} ${RESET}` : ` ${text}`);
      });
      const stats = this.session.lastStats;
      const status = this.query === ''
        ? 'type pinyin (nihao, ni3hao3), hanzi (中国) or /english. Up/Down select, Enter detail, Esc quit'
        : `${this.rows.length} hits | ${stats?.mode ?? '-'} | ${this.lastMs.toFixed(2)} ms | bisected inside ${stats?.searched ?? 0} keys (${stats?.bisects ?? 0} bisects, ${stats?.reused ?? 0} reused)`;
      lines.push('', `${DIM}${fit(status, columns)}${RESET}`);
    }
    this.out.write(CLEAR + lines.join('\n'));
  }

  onKey(str, key) {
    if (key.ctrl && key.name === 'c') return this.quit();
    if (this.detail) {
      if (str === 'o' && this.detail.url) openUrl(this.detail.url);
      this.detail = null;
      return this.render();
    }
    if (key.name === 'escape') return this.quit();
    if (key.name === 'return') {
      if (this.rows[this.selected]) this.detail = this.rows[this.selected];
    } else if (key.name === 'up') {
      this.selected = Math.max(0, this.selected - 1);
    } else if (key.name === 'down') {
      this.selected = Math.min(this.rows.length - 1, this.selected + 1);
    } else if (key.name === 'backspace') {
      this.query = [...this.query].slice(0, -1).join('');
      this.runSearch();
    } else if (key.ctrl && key.name === 'u') {
      this.query = '';
      this.runSearch();
    } else if (str && !key.ctrl && !key.meta && str >= ' ') {
      this.query += str;
      this.runSearch();
    } else {
      return;
    }
    this.render();
  }

  quit() {
    this.out.write(`${CLEAR}`);
    process.exit(0);
  }
}

async function main(argv) {
  const lazy = argv.indexOf('--lazy');
  if (lazy >= 0) argv.splice(lazy, 1);
  if (argv.length !== 1) {
    console.error('usage: tui.js [--lazy] INDEX');
    process.exit(2);
  }
  if (!process.stdin.isTTY) {
    console.error('tui.js needs an interactive terminal');
    process.exit(2);
  }
  const t0 = performance.now();
  const dict = lazy >= 0 ? openIndexFile(argv[0]) : await loadIndex(argv[0]);
  const tui = new Tui(dict, process.stdout);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, key) => tui.onKey(str, key ?? {}));
  process.stdout.on('resize', () => { tui.runSearch(); tui.render(); });
  tui.lastMs = performance.now() - t0;
  tui.render();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
}
