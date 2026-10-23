#!/usr/bin/env python3
"""Emulator check of pronunciation by text-to-speech.

Usage: ADB=... python3 test/web/emulator_speech.py SERIAL DEBUG_APK SHOTS_DIR [LANG QUERY]

First plays the Wiktionary recording of 你好 twice (downloaded through the
app's audio proxy, then from its cache). Then, with "Always text-to-speech",
taps the speaker of 你好 and checks the app's Speech log: either the
engine spoke it (zh-CN) or, without a Chinese voice (or without any engine),
the page shows the matching hint. Then downloads LANG (default de) and taps the
speaker of its first result for QUERY (default Haus), which a stock
emulator voice (Pico: de, en, es, fr, it) can speak.
"""
import pathlib
import sys
import time

import emulator


def tap_first_speaker(page, dev, query):
    page.eval("document.body.dataset.spoke = ''")
    emulator.set_query(page, query)
    page.tap("#results li[data-index] button.speak")
    page.wait("!!document.body.dataset.spoke", 60, "speak")
    spoke = page.eval("document.body.dataset.spoke")
    hint = page.eval("document.getElementById('speech-hint').hidden ? '' : document.getElementById('speech-hint').innerText")
    status = page.eval("document.getElementById('status').textContent")
    log = dev.adb("logcat", "-d", "-s", "Speech", text=True).strip().splitlines()
    print(f"{query}: spoke={spoke} | status={status} | hint={hint!r}")
    print("  logcat:", log[-1] if log else "(none)")
    return spoke, hint, log


def main():
    serial, apk, shots = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
    lang, query = (sys.argv[4], sys.argv[5]) if len(sys.argv) > 5 else ("de", "Haus")
    shots.mkdir(parents=True, exist_ok=True)
    dev = emulator.Device(serial)
    pkg = "pl.d33.wiktionary.debug"
    dev.adb("uninstall", pkg, check=False)
    print(dev.adb("install", apk, text=True).strip())
    dev.adb("logcat", "-c")
    page = emulator.connect(dev, pkg)
    page.wait("!!document.body && document.body.dataset.ready === 'true'", 300, "start")
    print("engines:", dev.adb("shell", "cmd", "package", "query-services", "-a", "android.intent.action.TTS_SERVICE",
                              check=False, text=True).count("packageName"))

    # Wiktionary recording of 你好 through the app's /audio/ proxy: the first
    # play downloads it from Commons, the second comes from cacheDir/audio.
    for expected in ("downloaded", "from cache"):
        dev.adb("logcat", "-c")
        spoke, _, _ = tap_first_speaker(page, dev, "nihao")
        time.sleep(1)
        audio_log = dev.adb("logcat", "-d", "-s", "AudioProxy", text=True).strip().splitlines()
        print("  AudioProxy:", audio_log[-1] if audio_log else "(none)")
        assert spoke == "audio:ok", spoke
        assert any(expected in line for line in audio_log), audio_log
    players = dev.adb("shell", "dumpsys", "audio", text=True)
    print("  dumpsys audio players for the app:",
          [l.strip() for l in players.splitlines() if "AudioPlaybackConfiguration" in l and "u/pid:" in l][-2:])
    dev.screenshot(shots / "audio-nihao.png")

    page.eval("(() => { const s = document.getElementById('pron-mode'); s.value = 'speech'; s.dispatchEvent(new Event('change')); })()")
    dev.adb("logcat", "-c")
    spoke, hint, log = tap_first_speaker(page, dev, "nihao")
    if spoke == "speech:ok":
        assert any("speak zh-CN \"你好\": 0" in line for line in log), log
    elif spoke == "speech:no-engine":
        # Images without any TTS engine (e.g. android-34 default): the hint is the check.
        assert "No text-to-speech engine" in hint, hint
        dev.screenshot(shots / "speech-1-nihao.png")
        print("OK (no text-to-speech engine on this image)")
        return
    else:
        assert spoke == "speech:no-voice" and "No text-to-speech voice for Chinese" in hint, (spoke, hint)
        assert any("no voice for zh-CN" in line for line in log), log
    dev.screenshot(shots / "speech-1-nihao.png")

    page.eval("(() => { const s = document.getElementById('lang'); s.value = '__more'; s.dispatchEvent(new Event('change')); })()")
    page.wait("/languages available/.test(document.getElementById('picker-status').textContent)", 120, "manifest")
    page.eval(f"(() => {{ const f = document.getElementById('lang-filter'); f.value = '{lang}'; f.dispatchEvent(new Event('input')); }})()")
    page.eval(f"Array.from(document.querySelectorAll('#lang-list li[data-code=\"{lang}\"] button')).find((b) => /^Download dictionary/.test(b.textContent)).click()")
    time.sleep(1)
    # Large indexes ask for a second tap.
    page.eval(f"(() => {{ const b = Array.from(document.querySelectorAll('#lang-list li[data-code=\"{lang}\"] button')).find((x) => x.textContent === 'Download anyway'); if (b) b.click(); }})()")
    page.wait(f"document.body.dataset.lang === '{lang}' && document.body.dataset.ready === 'true'", 600, "download")
    spoke, hint, log = tap_first_speaker(page, dev, query)
    assert spoke in ("speech:ok", "speech:no-voice"), spoke
    dev.screenshot(shots / "speech-2-other.png")
    print("OK")


if __name__ == "__main__":
    sys.exit(main())
