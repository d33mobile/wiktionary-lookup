#!/usr/bin/env python3
"""Emulator check of a Wikipedia title index: download the Polish Wikipedia
from the language screen, search a title, tap it: the article opens in the
app's page panel.

Usage: ADB=... python3 test/web/emulator_wikipedia.py SERIAL DEBUG_APK SHOTS_DIR
"""
import json
import pathlib
import sys
import time

import emulator


def main():
    serial, apk, shots = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
    shots.mkdir(parents=True, exist_ok=True)
    dev = emulator.Device(serial)
    pkg = "pl.d33.wiktionary.debug"
    print(dev.adb("install", "-r", apk, text=True).strip())
    page = emulator.connect(dev, pkg)
    page.wait("!!document.body && !!document.body.dataset.screen", 300, "start")
    emulator.past_welcome(page)
    page.eval("(() => { document.getElementById('gear').click(); document.getElementById('opt-more').click(); })()")
    page.wait("!!document.querySelector('#lang-list li[data-code=\"wikipedia-pl\"]')", 120, "catalogue")
    print("picker:", page.eval("document.querySelector('#lang-list li[data-code=\"wikipedia-pl\"]').innerText.replace(/\\n/g, ' | ')"))
    page.eval("Array.from(document.querySelectorAll('#lang-list li[data-code=\"wikipedia-pl\"] button')).find((b) => /^Download/.test(b.textContent)).click()")
    time.sleep(1)
    # Above 64 MiB unpacked the list asks for a second tap.
    page.eval("(() => { const b = Array.from(document.querySelectorAll('#lang-list li[data-code=\"wikipedia-pl\"] button')).find((x) => x.textContent === 'Download anyway'); if (b) b.click(); })()")
    t0 = time.monotonic()
    page.wait("document.body.dataset.lang === 'wikipedia-pl' && document.body.dataset.ready === 'true'", 900, "download")
    print(f"downloaded and opened in {time.monotonic() - t0:.0f} s:", page.eval("document.getElementById('status').textContent"))
    r = emulator.set_query(page, "Kraków")
    print("Kraków ->", r)
    page.tap("#results li[data-index] .words")
    t1 = time.monotonic()
    while True:
        st = json.loads(page.eval("window.WiktionaryNative.pageState()"))
        if st["visible"] and st["title"]:
            break
        if time.monotonic() - t1 > 60:
            raise TimeoutError(st)
        time.sleep(0.2)
    print(f"article in the panel after {time.monotonic() - t1:.1f} s:", st["title"], st["url"])
    time.sleep(1)
    dev.screenshot(shots / "wikipedia-article.png")
    dev.adb("shell", "input", "keyevent", "KEYCODE_BACK")
    print("OK")


if __name__ == "__main__":
    sys.exit(main())
