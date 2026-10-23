#!/usr/bin/env python3
"""Emulator check of the no-network state: with Wi-Fi and mobile data off,
Download shows the "No network for this app" hint and "Open app settings",
which must open the system App info screen of this app. First a fresh
install started offline: the language list (from the copy in the APK)
shows, and downloading Chinese from it shows the same hint.

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

def network(on):
    for what in ('wifi', 'data'):
        dev.adb('shell', 'svc', what, 'enable' if on else 'disable')
    time.sleep(5)


# A first start without network: no language, the list from the APK.
network(False)
try:
    page = emulator.connect(dev, pkg)
    page.wait("document.body && document.body.dataset.screen === 'welcome'", 300, 'offline start')
    page.wait("!/checking for updates/.test(document.getElementById('picker-status').textContent)", 120, 'offline catalogue')
    print('offline first start:', page.eval("document.getElementById('picker-status').textContent"))
    page.tap('#lang-list li[data-code="zh"] .lang-actions button')
    page.wait("/No network for this app/.test(document.getElementById('picker-status').textContent)", 60, 'offline hint')
    print('offline download:', page.eval("document.getElementById('picker-status').textContent"))
    assert page.eval("!document.getElementById('network-actions').hidden")
    assert page.eval("document.body.dataset.screen") == 'welcome'
    dev.screenshot(shots / 'nonet-0-first-start.png')
finally:
    network(True)

page = emulator.connect(dev, pkg)
page.wait("!!document.body && !!document.body.dataset.screen", 300, 'start')
emulator.past_welcome(page)
network(False)
try:
    page.eval("(() => { document.getElementById('gear').click(); document.getElementById('opt-more').click(); })()")
    page.wait("/could not check|available/.test(document.getElementById('picker-status').textContent)", 120, 'refresh')
    print('refresh:', page.eval("document.getElementById('picker-status').textContent"))
    page.eval("(() => { const f = document.getElementById('lang-filter'); f.value = 'smj'; f.dispatchEvent(new Event('input')); })()")
    page.eval("Array.from(document.querySelectorAll('#lang-list li[data-code=\"smj\"] button')).find((b) => b.textContent.indexOf('Download dictionary') === 0).click()")
    time.sleep(2)
    print('download:', page.eval("document.getElementById('picker-status').textContent"))
    assert 'No network for this app' in page.eval("document.getElementById('picker-status').textContent")
    print('actions visible:', page.eval("!document.getElementById('network-actions').hidden"),
          '| data saver button visible:', page.eval("!document.getElementById('open-data-saver').hidden"))
    dev.screenshot(shots / 'nonet-1-hint.png')
    page.eval("document.getElementById('open-app-settings').click()")
    # Slow devices take a while to show App info: poll the screen.
    t0 = time.monotonic()
    while True:
        time.sleep(3)
        dev.adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml', check=False)
        ui = dev.adb('shell', 'cat', '/sdcard/ui.xml', text=True)
        if 'App info' in ui or time.monotonic() - t0 > 90:
            break
    focus = dev.adb('shell', 'dumpsys', 'activity', 'activities', text=True)
    print('top activity:', re.search(r'topResumedActivity=.*', focus).group(0) if re.search(r'topResumedActivity=.*', focus) else '?')
    texts = re.findall(r'text="([^"]+)"', ui)
    print('screen texts:', texts[:12])
    assert any('Wiktionary' in t for t in texts) and 'App info' in texts, texts
    dev.screenshot(shots / 'nonet-2-app-info.png')
finally:
    network(True)
print('OK')
