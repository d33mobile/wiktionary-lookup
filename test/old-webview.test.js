// The Android app runs web/ and the engine in the system WebView, which on
// Android 9 without updates is Chromium 66. That version rejects newer syntax
// at parse time (one `??` stops the whole module graph) and lacks newer
// built-ins, so these files are held to what Chromium 66 supports: ES2018
// plus nothing newer. The check tokenizes each file (comments, strings,
// templates and regex literals are skipped as whole tokens) and looks at the
// token stream, so text inside strings or comments never trips it. The real
// proof is the app on the Android 9 emulator; this guards against regressions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WEB_FILES, ENGINE_FILES } from '../stage-web.js';

const ROOT = join(import.meta.dirname, '..');
const VENDOR_DIR = 'web/vendor/hanzilookup/src';
const FILES = [
  ...WEB_FILES.filter((f) => f.endsWith('.js')).map((f) => `web/${f}`),
  ...ENGINE_FILES.map((f) => `lib/${f}`),
  ...readdirSync(join(ROOT, VENDOR_DIR)).filter((f) => f.endsWith('.js')).map((f) => `${VENDOR_DIR}/${f}`),
];

// Built-ins newer than Chromium 66, as member or global names.
const NEW_MEMBERS = new Set(['replaceAll', 'replaceChildren', 'toggleAttribute', 'at', 'flat', 'flatMap', 'fromEntries', 'matchAll', 'hasOwn',
  'findLast', 'findLastIndex', 'allSettled', 'any', 'groupBy', 'toSorted', 'toReversed', 'withResolvers']);
const NEW_GLOBALS = new Set(['globalThis', 'structuredClone', 'queueMicrotask', 'BigInt', 'WeakRef',
  'FinalizationRegistry', 'AggregateError']);
// Allowed only behind a feature check, in the files that implement the fallback.
const GUARDED_GLOBALS = new Map([['DecompressionStream', 'web/languages.js'], ['TransformStream', 'web/languages.js']]);
const PUNCTUATORS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '??=', '||=', '&&=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '**', '<<', '>>'];
// After these tokens a `/` starts a regex literal, otherwise it divides.
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*',
  '%', '<', '>', '~', '^', '=>', '==', '===', '!=', '!==', '<=', '>=', '&&', '||', '??', '+=', '-=',
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

// -> [{type: 'name'|'num'|'punct'|'string'|'template'|'regex', value, line}]
export function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  const push = (type, value) => tokens.push({ type, value, line });
  const skipQuoted = (quote) => {
    let j = i + 1;
    while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1;
    return j + 1;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (src.startsWith('//', i)) { i = src.indexOf('\n', i); if (i < 0) i = src.length; continue; }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2) + 2;
      line += (src.slice(i, end).match(/\n/g) || []).length;
      i = end;
      continue;
    }
    if (c === '"' || c === "'") { const j = skipQuoted(c); push('string', src.slice(i, j)); i = j; continue; }
    if (c === '`') {
      // Template: nested ${...} may hold any code, so tokens inside are scanned too.
      let j = i + 1;
      let depth = 0;
      for (; j < src.length; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (depth === 0 && src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j++; continue; }
        if (depth > 0 && src[j] === '}') depth--;
        if (src[j] === '\n') line++;
      }
      const body = src.slice(i, j + 1);
      for (const t of tokenize(body.replace(/^`|`$/g, '').replace(/(^|\})[^$]*?(\$\{|$)/g, ' '))) push(t.type, t.value);
      push('template', body);
      i = j + 1;
      continue;
    }
    if (c === '/') {
      const prev = tokens[tokens.length - 1];
      if (!prev || REGEX_AFTER.has(prev.value)) {
        let j = i + 1;
        let inClass = false;
        while (j < src.length && (inClass || src[j] !== '/')) {
          if (src[j] === '\\') j++;
          else if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          j++;
        }
        j++;
        while (/[a-z]/.test(src[j])) j++;
        push('regex', src.slice(i, j));
        i = j;
        continue;
      }
    }
    const name = /^[A-Za-z_$#][\w$]*/.exec(src.slice(i, i + 200));
    if (name) { push('name', name[0]); i += name[0].length; continue; }
    const num = /^(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?[\d_]+)?|\.\d[\d_]*)n?/.exec(src.slice(i, i + 100));
    if (num) { push('num', num[0]); i += num[0].length; continue; }
    const p = PUNCTUATORS.find((op) => src.startsWith(op, i));
    // `?.` followed by a digit is a conditional with a decimal (a?.5:b).
    if (p && !(p === '?.' && /\d/.test(src[i + 2]))) { push('punct', p); i += p.length; continue; }
    push('punct', c);
    i++;
  }
  return tokens;
}

// -> ['line N: message', ...]
export function problems(src, file) {
  const out = [];
  const tokens = tokenize(src);
  const classBodies = []; // brace depth of each open class body
  let depth = 0;
  tokens.forEach((t, k) => {
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    const at = (msg) => out.push(`line ${t.line}: ${msg}`);
    if (t.type === 'punct' && ['??', '??=', '||=', '&&=', '?.'].includes(t.value)) at(`operator ${t.value} (Chromium 80/85)`);
    if (t.type === 'num' && (t.value.includes('_') || t.value.endsWith('n'))) at(`number literal ${t.value} (Chromium 75/67)`);
    if (t.type === 'name' && t.value.startsWith('#')) at(`private name ${t.value} (Chromium 74)`);
    if (t.type === 'name' && t.value === 'catch' && next && next.value === '{') at('catch without a binding (ES2019)');
    if (t.type === 'regex' && /\/[a-z]*[dv][a-z]*$/.test(t.value)) at(`regex flag in ${t.value}`);
    if (t.type === 'name' && prev && prev.value === '.' && next && next.value === '(' && NEW_MEMBERS.has(t.value)) at(`.${t.value} (newer than Chromium 66)`);
    if (t.type === 'name' && (!prev || prev.value !== '.') && NEW_GLOBALS.has(t.value)) at(`${t.value} (newer than Chromium 66)`);
    if (t.type === 'name' && (!prev || prev.value !== '.') && GUARDED_GLOBALS.has(t.value) && GUARDED_GLOBALS.get(t.value) !== file) {
      at(`${t.value} outside its feature-checked fallback`);
    }
    if (t.value === '{') {
      depth++;
      // `class X {` or `class X extends Y {`: the class body.
      const head = tokens.slice(Math.max(0, k - 4), k).map((x) => x.value);
      if (head.includes('class')) classBodies.push(depth);
    } else if (t.value === '}') {
      if (classBodies[classBodies.length - 1] === depth) classBodies.pop();
      depth--;
    } else if (classBodies[classBodies.length - 1] === depth && t.type === 'name'
      && prev && ['{', '}', ';'].includes(prev.value) && next && ['=', ';'].includes(next.value)) {
      at(`class field ${t.value} (Chromium 72)`);
    } else if (classBodies[classBodies.length - 1] === depth && t.value === 'static' && next && next.value === '{') {
      at('static block');
    }
  });
  return out;
}

test('the checker catches what Chromium 66 rejects', () => {
  const bad = [
    'a ?? b', 'a?.b', 'x ||= 1', 'try {} catch {}', 'const n = 1_000;', 'class A { x = 1; }',
    'class A { #p() {} }', 's.replaceAll("a", "b")', 'globalThis.x', '/a/d.test(s)', 'new DecompressionStream("gzip")',
  ];
  for (const src of bad) assert.notDeepEqual(problems(src, 'web/app.js'), [], src);
  const good = [
    'a ? .5 : b', '"a ?? b"', '// a?.b', '/* x ?? y */', '`${a} ?? b`', 'const r = /\\?\\?/;', 'x / 2 / y',
    'class A { m() { this.x = 1; } }', 'try {} catch (e) {}', 'const o = { ...p };', 'for await (const x of y) {}',
    's.replace(/a/g, "b")', 'x.at', '"replaceAll"',
  ];
  for (const src of good) assert.deepEqual(problems(src, 'web/app.js'), [], src);
});

for (const file of FILES) {
  test(`${file} uses only what Chromium 66 supports`, () => {
    assert.deepEqual(problems(readFileSync(join(ROOT, file), 'utf8'), file), []);
  });
}
