#!/usr/bin/env python3
"""Emulator check of the handwriting pad with real touch input (DevTools
Input.dispatchTouchEvent): draws 一 and then 十 on the pad, checks they are
among the candidates, picks 十 and checks the query.

Usage: ADB=... python3 test/web/emulator_handwriting.py SERIAL DEBUG_APK SHOTS_DIR
"""
import pathlib
import sys
import time

import emulator


def touch_stroke(page, points, steps=10):
    page.call("Input.dispatchTouchEvent", type="touchStart", touchPoints=[{"x": points[0][0], "y": points[0][1]}])
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        for i in range(1, steps + 1):
            x = x0 + (x1 - x0) * i / steps
            y = y0 + (y1 - y0) * i / steps
            page.call("Input.dispatchTouchEvent", type="touchMove", touchPoints=[{"x": x, "y": y}])
    page.call("Input.dispatchTouchEvent", type="touchEnd", touchPoints=[])


def draw(page, strokes):
    box = page.eval("(() => { const r = document.getElementById('pad-canvas').getBoundingClientRect();"
                    " return [r.left, r.top, r.width]; })()")
    scale = box[2] / 280
    for stroke in strokes:
        touch_stroke(page, [(box[0] + x * scale, box[1] + y * scale) for x, y in stroke])
        time.sleep(0.3)


def wait_candidates(page, strokes):
    page.wait(f"window.__strokes === {strokes} && /^\\d+ candidates/.test(document.getElementById('pad-status').textContent)",
              30, "candidates")
    return page.eval("Array.from(document.querySelectorAll('#pad-candidates .pad-candidate'), (b) => b.textContent)")


def main():
    serial, apk, shots = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
    shots.mkdir(parents=True, exist_ok=True)
    dev = emulator.Device(serial)
    pkg = "pl.d33.wiktionary.debug"
    print(dev.adb("install", "-r", apk, text=True).strip())
    dev.adb("shell", "pm", "clear", pkg)
    page = emulator.connect(dev, pkg)
    page.wait("!!document.body && document.body.dataset.screen === 'welcome'", 300, "welcome")
    page.tap('#lang-list li[data-code="zh"] button')
    page.wait("document.body.dataset.screen === 'search'", 30, "search screen")
    t0 = time.monotonic()
    page.tap("#pen")
    page.wait("document.body.dataset.pad === 'ready'", 60, "pad")
    print(f"pad ready after {time.monotonic() - t0:.1f} s:", page.eval("document.getElementById('pad-status').textContent"))
    # Opening the pad hides the soft keyboard; let the layout settle before measuring.
    time.sleep(2)
    page.eval("window.__strokes = 0; document.getElementById('pad-canvas').addEventListener('pointerup', () => { window.__strokes++; }); 1")
    draw(page, [[(40, 140), (240, 140)]])
    one = wait_candidates(page, 1)
    print("一 ->", one, "|", page.eval("document.getElementById('pad-status').textContent"))
    assert "一" in one, one
    page.tap("#pad-clear")
    page.eval("window.__strokes = 0; 1")
    draw(page, [[(40, 130), (240, 130)], [(140, 30), (140, 250)]])
    ten = wait_candidates(page, 2)
    print("十 ->", ten, "|", page.eval("document.getElementById('pad-status').textContent"))
    assert "十" in ten, ten
    dev.screenshot(shots / "06-handwriting.png")
    index = ten.index("十") + 1
    page.tap(f"#pad-candidates .pad-candidate:nth-child({index})")
    page.wait("document.getElementById('q').value === '十' && document.querySelectorAll('#results li[data-index]').length > 0", 30, "query")
    print("pick 十 -> first result:", page.eval("document.querySelector('#results li[data-index]').innerText.split('\\n')[0]"))
    dev.screenshot(shots / "06-handwriting-picked.png")
    print("OK")


if __name__ == "__main__":
    sys.exit(main())
