#!/usr/bin/env node
// Usage: node web/make-flags.js > web/flags.json
// Language code -> ISO 3166 country code for the flags in the language list,
// for the languages in data/languages.json that have one clear primary
// country. Languages spoken across several countries without a clear
// primary one, regional and minority languages, and historical,
// reconstructed and constructed languages get no flag (the app shows a
// script glyph instead); they are listed in NO_FLAG so the choice is
// explicit. Codes are the ones kaikki.org uses.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FLAGS = {
  en: 'GB', es: 'ES', it: 'IT', ru: 'RU', pt: 'PT', fr: 'FR', de: 'DE', sv: 'SE', fi: 'FI', zh: 'CN',
  pl: 'PL', nl: 'NL', ro: 'RO', lv: 'LV', ja: 'JP', el: 'GR', nb: 'NO', nn: 'NO', no: 'NO', hu: 'HU',
  cs: 'CZ', mk: 'MK', uk: 'UA', bg: 'BG', da: 'DK', ko: 'KR', tr: 'TR', vi: 'VN', hi: 'IN', tl: 'PH',
  id: 'ID', ga: 'IE', ar: 'SA', lt: 'LT', ka: 'GE', is: 'IS', sq: 'AL', te: 'IN', sw: 'TZ', hy: 'AM',
  fa: 'IR', th: 'TH', sk: 'SK', he: 'IL', ceb: 'PH', ms: 'MY', az: 'AZ', mt: 'MT', et: 'EE', kk: 'KZ',
  ta: 'IN', ml: 'IN', bn: 'BD', fo: 'FO', km: 'KH', ur: 'PK', lb: 'LU', af: 'ZA', my: 'MM', be: 'BY',
  sl: 'SI', gu: 'IN', bcl: 'PH', mn: 'MN', mr: 'IN', kn: 'IN', or: 'IN', as: 'IN', sr: 'RS', hr: 'HR',
  bs: 'BA', ky: 'KG', uz: 'UZ', tg: 'TJ', tk: 'TM', ps: 'AF', ne: 'NP', si: 'LK', lo: 'LA', am: 'ET',
  so: 'SO', mg: 'MG', ht: 'HT', gn: 'PY', dv: 'MV', dz: 'BT', rw: 'RW', rn: 'BI', ti: 'ER', kl: 'GL',
  rm: 'CH', gv: 'IM', mi: 'NZ', sm: 'WS', to: 'TO', fj: 'FJ', yue: 'HK', ilo: 'PH', war: 'PH',
  pag: 'PH', hil: 'PH', st: 'LS', tn: 'BW', ss: 'SZ', ny: 'MW', sn: 'ZW', zu: 'ZA', xh: 'ZA',
  jv: 'ID', su: 'ID', min: 'ID', ban: 'ID', tet: 'TL', bi: 'VU', tpi: 'PG', ho: 'PG', na: 'NR',
  tvl: 'TV', gil: 'KI', mh: 'MH', pau: 'PW', ch: 'GU', hif: 'FJ', crs: 'SC', mfe: 'MU', pap: 'CW',
  srn: 'SR', kea: 'CV', lu: 'CD', kg: 'CD', sg: 'CF', yo: 'NG', lus: 'IN', mni: 'IN',
};
// No flag on purpose (see above).
const NO_FLAG = new Set([
  'la', 'eo', 'mul', 'ang', 'grc', 'enm', 'io', 'got', 'nrf', 'sa', 'non', 'ota', 'pi', 'fro', 'xcl',
  'sga', 'frm', 'ca', 'eu', 'cy', 'gd', 'br', 'oc', 'sc', 'kw', 'ast', 'gl', 'lld', 'se', 'yi', 'nv',
  'izh', 'liv', 'rsk', 'sco', 'sh', 'kmr', 'ckb', 'ku', 'aii', 'ady', 'mak', 'kix', 'nci', 'nah', 'ia',
  'ie', 'vo', 'jbo', 'tok', 'nov', 'fy', 'li', 'wa', 'co', 'an', 'fur', 'vec', 'nap', 'scn', 'lij',
  'lmo', 'pms', 'haw', 'qu', 'ay', 'bo', 'ug', 'tt', 'ba', 'cv', 'os', 'ce', 'sah', 'ha', 'ig', 'ff',
  'wo', 'ln', 'om', 'iu', 'cr', 'oj', 'chr', 'nan', 'hak', 'wuu', 'cmn', 'dsb', 'hsb', 'csb', 'szl',
  'rue', 'frr', 'stq', 'nds', 'gsw', 'bar', 'ksh', 'pdc', 'lad', 'arc', 'syc', 'cop', 'egy', 'akk',
  'sux', 'hit', 'peo', 'ae', 'pal', 'xto', 'txb', 'osp', 'pro', 'gmh', 'goh', 'odt', 'osx', 'ofs',
  'dum', 'gml', 'mga', 'owl', 'wlm', 'xno', 'rup', 'ruo', 'mo', 'pa',
]);

const here = import.meta.dirname;
const { languages } = JSON.parse(readFileSync(join(here, '..', 'data', 'languages.json'), 'utf8'));
const out = {};
for (const { code } of languages) {
  if (NO_FLAG.has(code) || code.includes('-')) continue;
  const country = FLAGS[code];
  if (country) out[code] = country;
}
process.stdout.write(`${JSON.stringify(out, Object.keys(out).sort(), 1).replace(/\n /g, '\n  ')}\n`);
