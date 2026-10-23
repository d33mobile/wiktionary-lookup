# HanziLookupJS (vendored)

Handwriting recognition for Chinese characters, from
https://github.com/gugray/HanziLookupJS at commit
b21124f771ddd91f131e62aa478bc188f6ec78d3 (2019-08-07), unmodified:

- `src/*.js`: the library sources from `library/src/` (without the jQuery
  drawing board and the test bed). License: GNU GPL version 3 (`LICENSE`).
  Derived from Jordan Kiang's HanziLookup.
- `mmah.json`: stroke data for 9,507 characters, derived from Make Me a Hanzi's
  `graphics.txt`, which comes from the Arphic PL KaitiM GB and Arphic PL UKai
  fonts. License: Arphic Public License (`LICENSE-APL`, reproduced in full).

The app loads these files only when the handwriting pad is first opened.
