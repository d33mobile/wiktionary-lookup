# Third-party components and data in the Wiktionary Lookup app

The app (web/ and android/) is free software under the GNU General Public
License, version 3 or later (LICENSE). Its lookup engine (lib/) is MIT
licensed. Source code: https://github.com/d33mobile/wiktionary-lookup

It includes or uses:

- HanziLookupJS by gugray (https://github.com/gugray), derived from HanziLookup by Jordan Kiang:
  handwriting recognition (vendor/hanzilookup/src). GNU GPL version 3.
  https://github.com/gugray/HanziLookupJS
- Stroke data mmah.json (vendor/hanzilookup/mmah.json), derived from Make Me a
  Hanzi (https://github.com/skishore/makemeahanzi) graphics data, which comes
  from the Arphic PL KaitiM GB and Arphic PL UKai fonts. Arphic Public
  License, reproduced in full in vendor/hanzilookup/LICENSE-APL.
- Stroke order and character data (an optional download, hanzi.pack in the
  data release), converted from Make Me a Hanzi
  (https://github.com/skishore/makemeahanzi): the stroke outlines and medians
  (graphics.txt) derive from the Arphic PL KaitiM GB and Arphic PL UKai fonts
  and are under the Arphic Public License (vendor/hanzilookup/LICENSE-APL);
  the decompositions, radicals and etymologies (dictionary.txt) derive from
  Unihan and CJKlib and are under the GNU Lesser General Public License,
  version 3 or later (https://www.gnu.org/licenses/lgpl-3.0.html), which
  adds permissions to the GNU GPL version 3. The data release carries the
  license texts next to hanzi.pack.gz: Arphic-Public-License.txt,
  LGPL-3.0.txt and GPL-3.0.txt.
- Dictionary data: English Wiktionary (https://en.wiktionary.org/), extracted
  by wiktextract and published by kaikki.org. CC BY-SA 4.0 and GFDL. Credit to
  the Wiktionary contributors.
- Pronunciation recordings: Wikimedia Commons, each under its own free license
  (shown on the file's Commons page).
- Android: AndroidX WebKit (Apache License 2.0) and, when the build enables
  crash reporting, the Sentry Android SDK (MIT).
