#!/usr/bin/env python3
"""Emulator check of the no-network state: with Wi-Fi and mobile data off,
Download shows the "No network for this app" hint and "Open app settings",
which must open the system App info screen of this app.

Usage: ADB=... python3 test/web/emulator_nonet.py SERIAL DEBUG_APK SHOTS_DIR
"""
import pathlib, re, sys, time
import emulator
serial, apk, shots = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
shots.mkdir(parents=True, exist_ok=True)
dev = emulator.Device(serial)
pkg = 'pl.d33.wiktionary.debug'
dev.adb('uninstall', pkg, check=False)
print(dev.adb('install', apk, text=True).strip())
page = emulator.connect(dev, pkg)
page.wait("!!document.body && document.body.dataset.ready === 'true'", 300, 'start')
dev.adb('shell', 'svc', 'wifi', 'disable'); dev.adb('shell', 'svc', 'data', 'disable'); time.sleep(5)
page.eval("(() => { const s = document.getElementById('lang'); s.value = '__more'; s.dispatchEvent(new Event('change')); })()")
page.wait("/could not check|available/.test(document.getElementById('picker-status').textContent)", 120, 'refresh')
print('refresh:', page.eval("document.getElementById('picker-status').textContent"))
page.eval("(() => { const f = document.getElementById('lang-filter'); f.value = 'smj'; f.dispatchEvent(new Event('input')); })()")
page.eval("Array.from(document.querySelectorAll('#lang-list li[data-code=\"smj\"] button')).find((b) => b.textContent.indexOf('Download dictionary') === 0).click()")
time.sleep(2)
print('download:', page.eval("document.getElementById('picker-status').textContent"))
print('actions visible:', page.eval("!document.getElementById('network-actions').hidden"),
      '| data saver button visible:', page.eval("!document.getElementById('open-data-saver').hidden"))
dev.screenshot(shots / 'nonet-1-hint.png')
page.eval("document.getElementById('open-app-settings').click()")
time.sleep(4)
dev.adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml')
ui = dev.adb('shell', 'cat', '/sdcard/ui.xml', text=True)
focus = dev.adb('shell', 'dumpsys', 'activity', 'activities', text=True)
print('top activity:', re.search(r'topResumedActivity=.*', focus).group(0) if re.search(r'topResumedActivity=.*', focus) else '?')
texts = re.findall(r'text="([^"]+)"', ui)
print('screen texts:', texts[:12])
assert any('Wiktionary' in t for t in texts) and 'App info' in texts, texts
dev.screenshot(shots / 'nonet-2-app-info.png')
dev.adb('shell', 'svc', 'wifi', 'enable'); dev.adb('shell', 'svc', 'data', 'enable')
print('OK')
