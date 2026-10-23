#!/usr/bin/env python3
"""Generates the launcher icon: an open book on a red ground.

Writes the adaptive icon (vector background + foreground, API 26+) and PNG
mipmaps of the same drawing for tools that cannot render vector icons (the
F-Droid repo index). Usage: python3 android/make-icon.py  (needs rsvg-convert)
"""
import pathlib
import subprocess

RES = pathlib.Path(__file__).resolve().parent / "app" / "src" / "main" / "res"
BACKGROUND = "#B3261E"
PAGE = "#FFFFFF"
LINE = "#E8A49E"
# Adaptive icon canvas is 108 units; launchers show the central 72, the
# book stays inside the 66-unit safe zone.
PAGES = ["M30,36 L52,40 L52,76 L30,72 Z", "M56,40 L78,36 L78,72 L56,76 Z"]
LINES = [f"M{x0},{y0 + d} L{x1},{y1 + d}" for d in (12, 20, 28)
         for (x0, y0, x1, y1) in ((34, 37, 48, 39.5), (60, 39.5, 74, 37))]
LINE_WIDTH = 2.2
DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}


def vector(paths):
    body = "\n".join(paths)
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
            '    android:width="108dp" android:height="108dp"\n'
            '    android:viewportWidth="108" android:viewportHeight="108">\n'
            f"{body}\n</vector>\n")


def foreground_xml():
    paths = [f'    <path android:fillColor="{PAGE}" android:pathData="{d}" />' for d in PAGES]
    paths += [f'    <path android:strokeColor="{LINE}" android:strokeWidth="{LINE_WIDTH}" '
              f'android:strokeLineCap="round" android:pathData="{d}" />' for d in LINES]
    return vector(paths)


def svg(size):
    # Legacy icons get the central 72 units of the adaptive canvas, rounded.
    shapes = [f'<rect x="18" y="18" width="72" height="72" rx="16" fill="{BACKGROUND}"/>']
    shapes += [f'<path d="{d}" fill="{PAGE}"/>' for d in PAGES]
    shapes += [f'<path d="{d}" stroke="{LINE}" stroke-width="{LINE_WIDTH}" stroke-linecap="round"/>' for d in LINES]
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="18 18 72 72">'
            + "".join(shapes) + "</svg>")


def main():
    (RES / "drawable").mkdir(parents=True, exist_ok=True)
    (RES / "values").mkdir(parents=True, exist_ok=True)
    (RES / "mipmap-anydpi-v26").mkdir(parents=True, exist_ok=True)
    (RES / "drawable" / "ic_launcher_foreground.xml").write_text(foreground_xml())
    (RES / "values" / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        f'    <color name="ic_launcher_background">{BACKGROUND}</color>\n</resources>\n')
    (RES / "mipmap-anydpi-v26" / "ic_launcher.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/ic_launcher_background" />\n'
        '    <foreground android:drawable="@drawable/ic_launcher_foreground" />\n'
        '    <monochrome android:drawable="@drawable/ic_launcher_foreground" />\n'
        '</adaptive-icon>\n')
    for density, size in DENSITIES.items():
        out = RES / f"mipmap-{density}"
        out.mkdir(exist_ok=True)
        subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), "-o", str(out / "ic_launcher.png")],
                       input=svg(size).encode(), check=True)


if __name__ == "__main__":
    main()
