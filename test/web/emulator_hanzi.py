#!/usr/bin/env python3
"""Emulator check of the character section (stroke order) on a device.

Usage: ADB=... python3 test/web/emulator_hanzi.py SERIAL DEBUG_APK SHOTS_DIR

A fresh install downloads Chinese, opens 好 and checks the words with 好
(你好 among them); downloads the character data the page offers (from the
data release), then: 6 strokes, radical 女, components 女 and 子; Restart,
Step and Play draw it to the end; the component 女 opens its entry (3 strokes).
"""
import pathlib
import sys
import time

import emulator


def main():
    serial, apk, shots = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
    shots.mkdir(parents=True, exist_ok=True)
    dev = emulator.Device(serial)
    pkg = "pl.d33.wiktionary.debug"
    dev.adb("uninstall", pkg, check=False)
    print(dev.adb("install", apk, text=True).strip())
    page = emulator.connect(dev, pkg)
    page.wait("!!document.body && !!document.body.dataset.screen", 300, "start")
    emulator.past_welcome(page)
    emulator.set_query(page, "好")
    page.tap("#results li[data-index]")
    page.wait("document.body.dataset.detail === '好' && document.body.dataset.hanzi === 'none'", 120, "好 without data")
    words = page.eval("Array.from(document.querySelectorAll('.hz-word'), (b) => b.dataset.word)")
    print("words with 好:", words[:8], "| offer:", page.eval("document.getElementById('hanzi-get').textContent"))
    assert "你好" in words, words
    page.tap("#hanzi-get")
    took = page.wait("document.body.dataset.hanzi === 'loaded'", 900, "character data")
    print(f"character data downloaded and opened in {took:.0f} s")
    facts = page.eval("document.querySelector('.hz-facts').textContent")
    comps = page.eval("document.querySelector('.hz-section').dataset.components")
    print("好 ->", facts, "|", page.eval("(document.querySelector('.hz-etymology') || {}).textContent"), "| components", comps)
    assert page.eval("document.querySelector('.hz-facts').dataset.strokes") == "6" and "radical 女" in facts
    assert comps == "女子", comps
    page.eval("document.querySelector('.hz-section').scrollIntoView()")
    page.tap(".hz-restart")
    page.tap(".hz-step")
    assert page.eval("document.querySelector('.hz-player').dataset.stroke") == "1"
    t0 = time.monotonic()
    page.tap(".hz-play")
    page.wait("document.querySelector('.hz-player').dataset.stroke === '6'"
              " && document.querySelector('.hz-player').dataset.playing === 'false'", 60, "play to the end")
    print(f"Step, Play -> all 6 strokes drawn in {time.monotonic() - t0:.1f} s")
    dev.screenshot(shots / "hanzi-1-hao.png")
    page.tap('.hz-component[data-char="女"]')
    page.wait("document.body.dataset.detail === '女' && document.body.dataset.hanzi === 'loaded'", 60, "女")
    print("tap 女 ->", page.eval("document.querySelector('.hz-facts').textContent"))
    assert page.eval("document.querySelector('.hz-facts').dataset.strokes") == "3"
    page.eval("document.querySelector('.hz-section').scrollIntoView()")
    time.sleep(1)
    dev.screenshot(shots / "hanzi-2-nv.png")
    print("OK")


if __name__ == "__main__":
    sys.exit(main())
