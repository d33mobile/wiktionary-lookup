#!/usr/bin/env python3
"""Emulator check of the 0.5 app flow over DevTools, from cleared app data.

Usage: ADB=... python3 test/web/emulator_app.py SERIAL DEBUG_APK SHOTS_DIR

1. `pm clear`: the first start shows "Choose a language" with flags
   (screenshot shows how the system font renders them); Use on Chinese
   shows the search screen.
2. nihao: the recording of 你好 is prefetched (logcat "prefetched"), then
   a tap on its speaker plays it "from cache".
3. Detail of 你好 (the details block is loaded), tap 好 in the headword: 好's entry with "In this text:
   你好"; the Android Back key returns to 你好, again to the list.
4. "What's new": with the last seen version set to 3, a reload shows the
   0.5 and 0.4 notes; OK hides them.
"""
import pathlib
import re
import sys
import time

import emulator


def logcat(dev, tag):
    return dev.adb("logcat", "-d", "-s", tag, text=True).strip().splitlines()


def main():
    serial, apk, shots = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
    shots.mkdir(parents=True, exist_ok=True)
    dev = emulator.Device(serial)
    pkg = "pl.d33.wiktionary.debug"
    print(dev.adb("install", "-r", apk, text=True).strip())
    print("pm clear:", dev.adb("shell", "pm", "clear", pkg, text=True).strip())
    dev.adb("logcat", "-c")
    page = emulator.connect(dev, pkg)
    page.wait("!!document.body && document.body.dataset.screen === 'welcome'", 300, "welcome")
    print("first start:", page.eval("document.getElementById('picker-title').textContent"), "|",
          page.eval("document.querySelector('#lang-list li[data-code=zh]').innerText.replace(/\\n/g, ' ')"))
    page.wait("document.querySelectorAll('#lang-list li[data-code]').length > 100", 120, "remote list")
    print("marks:", page.eval("['zh', 'de', 'ja', 'la', 'eo', 'fr'].map((c) => { const m = document.querySelector("
                              "`#lang-list li[data-code=${c}] .lang-mark`); return c + ' ' + (m ? m.textContent : '-'); })"))
    dev.screenshot(shots / "05-1-welcome.png")
    emulator.past_welcome(page)
    print("chose Chinese -> search screen:", page.eval("document.getElementById('status').textContent"))

    emulator.set_query(page, "nihao")
    t0 = time.monotonic()
    while not any("Zh nǐ hǎo.ogg" in l and "prefetched" in l for l in logcat(dev, "AudioProxy")):
        if time.monotonic() - t0 > 60:
            raise TimeoutError(logcat(dev, "AudioProxy"))
        time.sleep(1)
    print("prefetch:", [l.split("AudioProxy: ")[-1] for l in logcat(dev, "AudioProxy")])
    page.wait("!!document.querySelector('#results li[data-index] button.speak-audio.cached')", 30, "cached mark")
    dev.screenshot(shots / "05-2-prefetched.png")
    dev.adb("logcat", "-c")
    page.tap("#results li[data-index] button.speak-audio")
    page.wait("document.body.dataset.spoke === 'audio:ok'", 30, "play")
    t0 = time.monotonic()
    while not any("from cache" in l for l in logcat(dev, "AudioProxy")):
        if time.monotonic() - t0 > 30:
            raise AssertionError(logcat(dev, "AudioProxy"))
        time.sleep(1)
    print("tap speaker:", [l.split("AudioProxy: ")[-1] for l in logcat(dev, "AudioProxy") if "AudioProxy:" in l])

    page.tap("#results li[data-index] .words")
    emulator.open_entry_pages(page, "你好")
    print("detail of 你好:", page.eval("Array.from(document.querySelectorAll('#detail .detail-h, #detail .detail-h4'), (h) => h.textContent)"),
          "| example:", page.eval("(document.querySelector('.ex-text') || {}).textContent"))
    dev.screenshot(shots / "05-3a-nihao.png")
    page.tap("#detail-head .ch:nth-of-type(2)")
    page.wait("document.body.dataset.detail === '好'", 30, "tap 好")
    print("tap 好 ->", page.eval("document.querySelector('.lookup-extras').innerText.replace(/\\n/g, ' ')"))
    dev.screenshot(shots / "05-3-hao.png")
    dev.adb("shell", "input", "keyevent", "KEYCODE_BACK")
    page.wait("document.body.dataset.detail === '你好'", 30, "back to 你好")
    dev.adb("shell", "input", "keyevent", "KEYCODE_BACK")
    page.wait("document.getElementById('detail').hidden", 30, "back to the list")
    print("Back key -> 你好 -> result list")

    page.eval("localStorage.setItem('wiktionary-lookup.seenVersion', '3'); location.reload(); 1")
    time.sleep(3)
    page = emulator.connect(dev, pkg, restart=False)
    page.wait("!!document.getElementById('changelog') && !document.getElementById('changelog').hidden", 60, "notes")
    print("What's new:", page.eval("Array.from(document.querySelectorAll('#changelog h3'), (h) => h.textContent)"))
    dev.screenshot(shots / "05-4-whats-new.png")
    page.tap("#changelog-close")
    page.wait("document.getElementById('changelog').hidden", 10, "close notes")

    # Back closes a secondary screen first; the app stays open.
    page.tap("#gear")
    page.wait("!document.getElementById('options').hidden", 10, "options")
    dev.adb("shell", "input", "keyevent", "KEYCODE_BACK")
    page.wait("document.getElementById('options').hidden && !document.getElementById('results').hidden", 10, "Back closes options")
    focus = dev.adb("shell", "dumpsys", "activity", "activities", text=True)
    assert pkg in (re.search(r"topResumedActivity=.*", focus) or re.search(r"mResumedActivity.*", focus)).group(0)
    print("options -> Back -> options closed, app still in front")
    print("OK")


if __name__ == "__main__":
    sys.exit(main())
