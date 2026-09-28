"""Generates the Android launcher icons and splash images from Cloth's logo (resources/icon.png).

Run from the repo root after `npx cap add android`:  python scripts/make-android-icons.py
"""
import math
import os
from PIL import Image, ImageDraw

RES = 'mobile/android/app/src/main/res'
BG_TOP, BG_BOTTOM = (27, 27, 31), (9, 9, 10)
C_TOP, C_BOTTOM = (239, 61, 92), (159, 24, 48)
DENSITIES = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}


def diagonal(size, a, b):
    """A top-left → bottom-right gradient."""
    g = Image.new('RGB', (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))
    return g


def glyph(size):
    """The C and its two dashes on a transparent square, drawn at 4x and scaled down."""
    s = size * 4
    k = s / 1024
    mask = Image.new('L', (s, s), 0)
    d = ImageDraw.Draw(mask)
    cx, cy, r, w = 512 * k, 512 * k, 230 * k, 92 * k
    # Arc from 40° to 320° (opening on the right), round caps.
    start, end = 40, 320
    d.arc([cx - r - w / 2, cy - r - w / 2, cx + r + w / 2, cy + r + w / 2], start, end, fill=255, width=round(w))
    for ang in (start, end):
        a = math.radians(ang)
        px, py = cx + r * math.cos(a), cy + r * math.sin(a)
        d.ellipse([px - w / 2, py - w / 2, px + w / 2, py + w / 2], fill=255)
    c = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    c.paste(diagonal(s, C_TOP, C_BOTTOM), (0, 0), mask)
    dash = Image.new('L', (s, s), 0)
    dd = ImageDraw.Draw(dash)
    for x0 in (410, 514):
        dd.rounded_rectangle([(x0 - 20) * k, 492 * k, (x0 + 60) * k, 532 * k], radius=20 * k, fill=140)
    c.paste(Image.new('RGBA', (s, s), (236, 236, 239, 255)), (0, 0), dash)
    return c.resize((size, size), Image.LANCZOS)


def adaptive_foreground(px):
    """108dp canvas; the glyph sits inside the 66dp safe zone."""
    canvas = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    g = glyph(round(px * 0.86))
    canvas.alpha_composite(g, ((px - g.width) // 2, (px - g.height) // 2))
    return canvas


def main():
    src = Image.open('resources/icon.png').convert('RGBA')
    # The logo's rounded square spans 64..960 of 1024; crop to it so legacy icons fill their tile.
    tile = src.crop((56, 56, 968, 968))
    for name, scale in DENSITIES.items():
        folder = f'{RES}/mipmap-{name}'
        os.makedirs(folder, exist_ok=True)
        legacy = round(48 * scale)
        tile.resize((legacy, legacy), Image.LANCZOS).save(f'{folder}/ic_launcher.png')
        # Round: dark disc with the glyph.
        disc = Image.new('RGBA', (legacy * 4, legacy * 4), (0, 0, 0, 0))
        m = Image.new('L', disc.size, 0)
        ImageDraw.Draw(m).ellipse([0, 0, disc.width - 1, disc.height - 1], fill=255)
        disc.paste(diagonal(disc.width, BG_TOP, BG_BOTTOM), (0, 0), m)
        disc.alpha_composite(glyph(disc.width))
        disc.resize((legacy, legacy), Image.LANCZOS).save(f'{folder}/ic_launcher_round.png')
        adaptive_foreground(round(108 * scale)).save(f'{folder}/ic_launcher_foreground.png')
    with open(f'{RES}/values/ic_launcher_background.xml', 'w') as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#111113</color>\n</resources>\n')

    # Splash (pre-Android 12 fallback): dark screen, small logo in the middle.
    for root, _, files in os.walk(RES):
        for f in files:
            if f == 'splash.png':
                path = os.path.join(root, f)
                w, h = Image.open(path).size
                img = Image.new('RGB', (w, h), BG_BOTTOM)
                g = glyph(round(min(w, h) * 0.28))
                img.paste(g, ((w - g.width) // 2, (h - g.height) // 2), g)
                img.save(path)
    print('icons and splash written')


if __name__ == '__main__':
    main()
