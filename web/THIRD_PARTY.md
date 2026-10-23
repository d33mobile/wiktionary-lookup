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
- Dictionary data: English Wiktionary (https://en.wiktionary.org/), extracted
  by wiktextract and published by kaikki.org. CC BY-SA 4.0 and GFDL. Credit to
  the Wiktionary contributors.
- Pronunciation recordings: Wikimedia Commons, each under its own free license
  (shown on the file's Commons page).
- Android: AndroidX WebKit (Apache License 2.0) and, when the build enables
  crash reporting, the Sentry Android SDK (MIT).
