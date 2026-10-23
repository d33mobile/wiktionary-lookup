import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toneMarksToNumbers } from '../lib/pinyin-marks.js';

const CASES = [
  ['nǐ hǎo', 'ni3 hao3', 'space-separated syllables'],
  ['xuéxí', 'xue2 xi2', 'syllables written together'],
  ['Zhōngguó', 'Zhong1 guo2', 'capitalised proper noun'],
  ['Āměilìjiā', 'A1 mei3 li4 jia1', 'capitalised vowel-initial word'],
  ['jì-dì-pì', 'ji4 di4 pi4', 'hyphens'],
  ['yī (yi¹)', 'yi1', 'trailing parenthesised note dropped'],
  ['le', 'le5', 'neutral tone'],
  ['pútaojiǔ', 'pu2 tao5 jiu3', 'neutral tone inside a word'],
  ['nǚ', 'nü3', 'u-umlaut with caron'],
  ['lǜ', 'lü4', 'u-umlaut with grave'],
  ['Lǚ', 'Lü3', 'capitalised u-umlaut'],
  ['nüè', 'nüe4', 'u-umlaut written without tone, tone on e'],
  ["Xī'ān", 'Xi1 an1', 'apostrophe'],
  ['Xī’ān', 'Xi1 an1', 'typographic apostrophe'],
  ["nǚ'ér", 'nü3 er2', 'apostrophe before er'],
  ['xiān', 'xian1', 'one syllable, not xi an'],
  ['dàngàn', 'dan4 gan4', 'a non-initial syllable does not start with a vowel'],
  ['huār', 'hua1 r5', 'erhua'],
  ['yīdiǎnr', 'yi1 dian3 r5', 'erhua after a nasal final'],
  ['érzi', 'er2 zi5', 'er as a syllable'],
  ['ńg', 'ng2', 'tone mark on a consonant'],
  ['ň', 'n3', 'syllabic n'],
  ['hm', 'hm5', 'toneless interjection'],
  ['yī ge, liǎng ge', 'yi1 ge5 , liang3 ge5', 'comma kept as a token'],
  ['shēngrì kuàilè', 'sheng1 ri4 kuai4 le4', 'two words'],
  ['kǎlā OK', 'ka3 la1 ok', 'Latin letters that are not pinyin'],
  ['Nǐ  hǎo', 'Ni3 hao3', 'repeated spaces'],
  ['Rìběnyǔ [Phonetic: rìbényǔ', 'Ri4 ben3 yu3', 'unclosed bracketed note dropped'],
  ['nǐ hǎo!', 'ni3 hao3', 'trailing exclamation mark'],
  ['hǎo ma?', 'hao3 ma5', 'trailing question mark'],
  ['', '', 'empty input'],
];

for (const [input, expected, why] of CASES) {
  test(`toneMarksToNumbers: ${why} (${JSON.stringify(input)})`, () => {
    assert.equal(toneMarksToNumbers(input), expected);
  });
}

test('precomposed and decomposed tone marks give the same result', () => {
  const precomposed = 'lǜsè';
  assert.equal(toneMarksToNumbers(precomposed.normalize('NFD')), toneMarksToNumbers(precomposed));
  assert.equal(toneMarksToNumbers(precomposed), 'lü4 se4');
});
