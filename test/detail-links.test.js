// web/detail.js glossText on a minimal DOM stub: link parts, tap-text
// character indexes around them, longest link text first. The click path is
// covered by test/web/smoke.py (word_links).
import { test } from 'node:test';
import assert from 'node:assert/strict';

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; }
  appendChild(child) { this.children.push(child); return child; }
  set textContent(text) { this.text = text; }
}
globalThis.document = { createElement: (tag) => new Node(tag), createTextNode: (text) => ({ text }) };
const { glossText, linkRanges } = await import('../web/detail.js');
const parts = (node) => node.children.map((c) => [c.tag ?? '#text', c.text, c.dataset?.i ?? c.dataset?.word ?? null]);

test('glossText: links as a.word-link, CJK characters around them keep their index', () => {
  const node = glossText('好 see 你好 and 你好吗 好', [['你好', '你好'], ['你好吗', '你好吗'], ['see', 'sehen']]);
  assert.equal(node.dataset.text, '好 see 你好 and 你好吗 好');
  assert.deepEqual(parts(node), [
    ['span', '好', '0'], ['#text', ' ', null], ['a', 'see', 'sehen'], ['#text', ' ', null], ['a', '你好', '你好'],
    ['#text', ' and ', null], ['a', '你好吗', '你好吗'], ['#text', ' ', null], ['span', '好', '17'],
  ]);
  assert.equal(node.children[2].href, '#');
  assert.equal(node.children[2].className, 'word-link');
});

test('glossText: no links (old data) and links whose text is missing', () => {
  assert.deepEqual(parts(glossText('Misspelling of ingenious.')), [['#text', 'Misspelling of ingenious.', null]]);
  assert.deepEqual(parts(glossText('a b', [['c', 'c'], 'junk', [null, 'x']])), [['#text', 'a b', null]]);
});

test('linkRanges: a shorter link never cuts a longer one', () => {
  assert.deepEqual(linkRanges('abc b', [['b', 'B'], ['abc', 'A']]), [{ start: 0, end: 3, word: 'A' }, { start: 4, end: 5, word: 'B' }]);
});
