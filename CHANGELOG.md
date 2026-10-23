# Changelog

Wiktionary Lookup, an offline dictionary built from English Wiktionary.

## 0.11 (versionCode 11)

- Handwriting: the strokes you draw are visible again on some Android 9 devices, where the pad stayed empty although recognition worked.
- Updates are offered only when the data on the server is newer than what is installed; an older list never downgrades a dictionary.
- Download progress and "Update all" show the download size, the same as the buttons.
- Diagnostics shows the dictionary opened at start, and the time from typing the first query to its results.
- The stroke order data comes with the GNU GPL text next to the LGPL in the data release.

## 0.10 (versionCode 10)

- Stroke order for Chinese characters: a one-character entry has a "Character" section that draws the character stroke by stroke (Play/Pause, Step, Restart), with the stroke count, radical, etymology and its components; tap a component to open it. The stroke data (Make Me a Hanzi, about 13 MB) is a separate download, offered there and in Options.
- Words containing the character, most common first, on the same section.
- Progress with size, percent and Cancel for every download (entry pages, updates, "Update all", Wikipedia, stroke data) in a bar under the search box, and "Opening <language>..." while a dictionary opens.
- An empty result list says what to type, or "No results" with search tips.
- Large dictionaries answer sooner: English is searchable in about half a second after you switch to it; results for headwords come first, definitions and recordings follow.
- "Update all" shows its overall progress (languages and size), the state of each language (queued, updated, failed with Retry) and carries on past a failed language.
- The search box stays at the top of every screen: tap it or type to go back to the results from the options, history, favourites or the language list; Back closes those screens first, and the gear turns into an X while the options are open.
- The Wiktionary page is kept laid out in the background while hidden, so opening it only slides it in (About > Diagnostics can switch back to the 0.9 behaviour). Diagnostics also shows timings of opening a dictionary and the Wiktionary page.
- The memory estimate for a large download reflects how the app reads it (in parts), the stars in the result list follow changes made on an entry page, and "1 entry" is no longer "1 entries".

## 0.9 (versionCode 9)

- Wikipedia: download the article titles of the English, German or Polish Wikipedia (with short descriptions) from the language screen; an article opens inside the app.
- "Open on Wiktionary" shows the Wiktionary page inside the app, loaded in the background while you read the entry.
- Large dictionaries (English: 261 MB) open in about 2 seconds without loading everything into memory, and you can type while a dictionary is still loading.
- Dictionary updates: when the data on the server is newer (for example with recordings), the language screen offers "Update" and "Update all", and a dot on the gear says so.
- History of the entries you opened, and favourites (the star on entries), with export and import.
- "What's new" shows the whole changelog; it is also in the options.
- Downloads are stored as files and read in parts, using less memory.
- Options behind the gear next to the search box: the language in use and "More languages...", updates, the handwriting pen, prefetching of recordings and pages, history, favourites, "What's new" and About.
- Chinese is no longer built into the app (a few MB instead of 54 MB): on first start choose a language (Chinese is the suggestion) and it is downloaded. If you used the built-in Chinese of an earlier version, download it once more from the same list.
- The speaker plays the Wiktionary recording when there is one; text-to-speech has its own button on the entry page. The "Always text-to-speech" option is gone.
- The handwriting pad closes when you open a result or an entry; the pen opens it again.

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
