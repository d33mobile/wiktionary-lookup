#!/usr/bin/env python3
"""Emulator check of the update from a release with the built-in Chinese
(0.8) to one without it (0.9 on), on the signed release APKs.

Usage: ADB=... python3 test/web/emulator_upgrade.py SERIAL OLD_APK NEW_APK SHOTS_DIR

Release builds have no DevTools, so the screen is read with uiautomator.
Installs OLD_APK fresh, takes the built-in Chinese ("Use") on the first
start and looks up nihao; installs NEW_APK over it: the start shows the
language list with the note that Chinese was built into earlier versions
and the suggested Chinese row, under "What's new" of the update; downloading it brings back the search.
"""
import pathlib
import re
import sys
import time

import emulator

PKG = "pl.d33.wiktionary"


def screen(dev):
    dev.adb("shell", "uiautomator", "dump", "/sdcard/ui.xml", check=False)
    ui = dev.adb("shell", "cat", "/sdcard/ui.xml", text=True)
    nodes = []
    for m in re.finditer(r'<node [^>]*?text="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', ui):
        label = m.group(1) or m.group(2)
        if label:
            x1, y1, x2, y2 = map(int, m.groups()[2:])
            nodes.append((label, (x1 + x2) // 2, (y1 + y2) // 2))
    return nodes


def wait_text(dev, pattern, timeout):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        nodes = screen(dev)
        hit = [n for n in nodes if re.search(pattern, n[0])]
        if hit:
            return hit[0], nodes
        time.sleep(3)
    raise TimeoutError(f"{pattern!r} not on screen: {[n[0] for n in screen(dev)][:30]}")


def tap(dev, node):
    dev.adb("shell", "input", "tap", str(node[1]), str(node[2]))


def start(dev):
    dev.adb("shell", "am", "force-stop", PKG)
    dev.adb("shell", "am", "start", "-n", f"{PKG}/{PKG}.MainActivity")


def main():
    serial, old_apk, new_apk, shots = sys.argv[1], sys.argv[2], sys.argv[3], pathlib.Path(sys.argv[4])
    shots.mkdir(parents=True, exist_ok=True)
    dev = emulator.Device(serial)
    dev.adb("uninstall", PKG, check=False)
    print("old:", dev.adb("install", old_apk, text=True).strip())
    start(dev)
    # 0.8 first start: the language list, the built-in Chinese has "Use".
    node, _ = wait_text(dev, r"^Use$", 600)
    tap(dev, node)
    wait_text(dev, r"Chinese: .*entries", 600)
    dev.adb("shell", "input", "text", "nihao")
    wait_text(dev, r"^你好", 120)
    print("old: built-in Chinese, nihao -> 你好")
    dev.screenshot(shots / "upgrade-1-old.png")

    print("new:", dev.adb("install", "-r", new_apk, text=True).strip())
    print("versionName:", re.search(r"versionName=\S+", dev.adb("shell", "dumpsys", "package", PKG, text=True)).group(0))
    start(dev)
    note, nodes = wait_text(dev, r"built into earlier versions", 600)
    # "What's new" of the update opens over the list: OK closes it.
    ok, _ = wait_text(dev, r"^OK$", 60)
    dev.screenshot(shots / "upgrade-2a-whats-new.png")
    tap(dev, ok)
    time.sleep(2)
    note, nodes = wait_text(dev, r"built into earlier versions", 60)
    print("new start:", note[0][:120])
    zh = [n for n in nodes if re.match(r"Download dictionary", n[0])]
    assert any("suggested" in n[0] for n in nodes), [n[0] for n in nodes][:30]
    dev.screenshot(shots / "upgrade-2-new.png")
    tap(dev, zh[0])
    # Large downloads may ask for a second tap.
    time.sleep(3)
    again = [n for n in screen(dev) if n[0] == "Download anyway"]
    if again:
        tap(dev, again[0])
    wait_text(dev, r"Chinese: .*entries", 900)
    dev.adb("shell", "input", "text", "nihao")
    wait_text(dev, r"^你好", 120)
    print("new: downloaded Chinese, nihao -> 你好")
    dev.screenshot(shots / "upgrade-3-downloaded.png")
    print("OK")


if __name__ == "__main__":
    sys.exit(main())
