# Changelog

Wiktionary Lookup, an offline dictionary built from English Wiktionary.

## 0.8 (versionCode 8)

- The release APK is built straight from the published source (README: "Release build"), with the same name, package and version.
- Long web addresses in "What's new" and "About" wrap on narrow screens.

## 0.7 (versionCode 7)

- Source code published: https://github.com/d33mobile/wiktionary-lookup (linked from About and licenses).
- Handwriting on older Android versions (Android 9 WebView): the strokes are drawn again, and drawing no longer selects text.
- Small downloads show their size in KiB instead of "0.0 MiB".

## 0.6 (versionCode 6)

- Handwriting input for Chinese and Japanese: tap the pen next to the search box and draw a character; the best 8 matches appear after every stroke. Recognition by HanziLookupJS with stroke data from Make Me a Hanzi.
- The app is now licensed under the GNU GPL, version 3 or later (the handwriting recognizer is GPL); "About and licenses" in the language screen lists all components and data licenses.
- All languages updated with recordings and entry pages.

## 0.5 (versionCode 5)

- Choose your language on first start; flags (or a script sign) next to every language.
- Entry pages laid out like Wiktionary: pronunciation lines, numbered senses per part of speech with examples, forms, etymology, synonyms and related words, and a link to the Wiktionary page.
- Tap any Chinese character in an entry to look it up; Back steps through the pages you opened.
- Separate icons: the speaker plays a Wiktionary recording and appears only where one exists; text-to-speech has its own button.
- Recordings of the results on screen are downloaded in the background (Wi-Fi only by default) and kept on the device.
- This "What's new" note after each update.
- The built-in Chinese dictionary now carries the entry pages (examples, etymologies, readings), so the app is larger (about 54 MB instead of 19 MB).

## 0.4 (versionCode 4)

- Pronunciation: Wiktionary recordings from Wikimedia Commons, or the system text-to-speech voice.
- When the app has no network (for example with per-app network access switched off), it says so and opens the right settings.
- Chinese dictionary updated, with recordings for about 3,600 words.

## 0.3 (versionCode 3)

- Works on older Android System WebView versions (Android 9).
- Download errors say what went wrong; failed downloads are retried.
- Better ranking: English words first when a query is also pinyin ("shit"), frequent words first.

## 0.2 (versionCode 2)

- Every language of English Wiktionary: pick one from the language list and download it.
- Results grouped by how they matched (headword, pinyin, English).
- New launcher icon.

## 0.1 (versionCode 1)

- First release: offline Chinese-English dictionary from Wiktionary with search as you type.
