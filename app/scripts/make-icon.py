# OwenFlow app icon generator.
# Rounded-square near-black (#0d0d14) tile with a microphone mark in a
# violet -> blue gradient (#8b5cf6 -> #3b82f6). Run: py -3.13 scripts/make-icon.py
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = 1024
SS = 4  # supersample factor for crisp antialiased masks
BIG = MASTER * SS

VIOLET = (0x8B, 0x5C, 0xF6)
BLUE = (0x3B, 0x82, 0xF6)
BG = (0x0D, 0x0D, 0x14)


def rounded_square_mask() -> Image.Image:
    m = Image.new('L', (BIG, BIG), 0)
    d = ImageDraw.Draw(m)
    pad = int(0.04 * BIG)  # small transparent margin so taskbar/tray doesn't clip
    radius = int(0.225 * BIG)
    d.rounded_rectangle([pad, pad, BIG - pad, BIG - pad], radius=radius, fill=255)
    return m.resize((MASTER, MASTER), Image.LANCZOS)


def mic_mask() -> Image.Image:
    """Bold microphone glyph, weights tuned to stay readable at 16px."""
    m = Image.new('L', (BIG, BIG), 0)
    d = ImageDraw.Draw(m)
    s = BIG / 1024  # design on a 1024 grid

    cx = 512 * s
    # capsule body: x 512+/-130, y 240..540 (rounded ends)
    d.rounded_rectangle([cx - 130 * s, 240 * s, cx + 130 * s, 540 * s], radius=130 * s, fill=255)
    # cradle: lower half-annulus centered (512, 470), outer r 224, stroke 78
    cy = 470 * s
    outer = 224 * s
    stroke = 78 * s
    d.pieslice([cx - outer, cy - outer, cx + outer, cy + outer], 0, 180, fill=255)
    inner = outer - stroke
    d.pieslice([cx - inner, cy - inner, cx + inner, cy + inner], 0, 180, fill=0)
    # punch out everything above the arc centerline except the capsule
    d.rectangle([0, 0, BIG, cy], fill=0)
    d.rounded_rectangle([cx - 130 * s, 240 * s, cx + 130 * s, 540 * s], radius=130 * s, fill=255)
    # round caps on the arc tips
    capr = stroke / 2
    for tx in (cx - outer + capr, cx + outer - capr):
        d.ellipse([tx - capr, cy - capr, tx + capr, cy + capr], fill=255)
    # stem: 694..790, width 78
    d.rectangle([cx - 39 * s, 690 * s, cx + 39 * s, 790 * s], fill=255)
    # base bar: width 300, y 790..858, rounded
    d.rounded_rectangle([cx - 150 * s, 790 * s, cx + 150 * s, 858 * s], radius=34 * s, fill=255)
    return m.resize((MASTER, MASTER), Image.LANCZOS)


def diagonal_gradient(bbox: tuple[int, int, int, int]) -> Image.Image:
    """Violet (top-left) -> blue (bottom-right), normalized across bbox."""
    n = 256
    x0, y0, x1, y1 = (v * n / MASTER for v in bbox)
    lo, hi = x0 + y0, x1 + y1
    g = Image.new('RGB', (n, n))
    px = g.load()
    for y in range(n):
        for x in range(n):
            t = min(1.0, max(0.0, (x + y - lo) / (hi - lo)))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(VIOLET, BLUE))
    return g.resize((MASTER, MASTER), Image.BICUBIC)


def build() -> Image.Image:
    bg_mask = rounded_square_mask()
    glyph = mic_mask()
    grad = diagonal_gradient(glyph.getbbox() or (0, 0, MASTER, MASTER))

    icon = Image.new('RGBA', (MASTER, MASTER), (0, 0, 0, 0))
    # tile
    tile = Image.new('RGBA', (MASTER, MASTER), BG + (255,))
    icon.paste(tile, (0, 0), bg_mask)

    # soft violet glow behind the glyph (premium feel; invisible at tiny sizes)
    glow = Image.new('RGBA', (MASTER, MASTER), (0, 0, 0, 0))
    glow_layer = Image.new('RGBA', (MASTER, MASTER), VIOLET + (0,))
    glow_alpha = glyph.filter(ImageFilter.GaussianBlur(70)).point(lambda a: int(a * 0.38))
    glow_layer.putalpha(glow_alpha)
    glow.alpha_composite(glow_layer)
    # keep glow inside the tile
    glow.putalpha(Image.composite(glow.getchannel('A'), Image.new('L', (MASTER, MASTER), 0), bg_mask))
    icon.alpha_composite(glow)

    # gradient glyph
    mark = grad.convert('RGBA')
    mark.putalpha(glyph)
    icon.alpha_composite(mark)

    # hairline inner border for definition on dark taskbars
    border = Image.new('L', (BIG, BIG), 0)
    bd = ImageDraw.Draw(border)
    pad = int(0.04 * BIG)
    bd.rounded_rectangle(
        [pad, pad, BIG - pad, BIG - pad], radius=int(0.225 * BIG), outline=255, width=int(2.5 * SS)
    )
    border = border.resize((MASTER, MASTER), Image.LANCZOS).point(lambda a: int(a * 0.16))
    edge = Image.new('RGBA', (MASTER, MASTER), (255, 255, 255, 0))
    edge.putalpha(border)
    icon.alpha_composite(edge)
    return icon


def main() -> None:
    master = build()
    p512 = master.resize((512, 512), Image.LANCZOS)
    build_dir = os.path.join(ROOT, 'build')
    res_dir = os.path.join(ROOT, 'resources')
    p512.save(os.path.join(build_dir, 'icon.png'))
    p512.save(os.path.join(res_dir, 'icon.png'))

    sizes = [256, 128, 64, 48, 32, 24, 16]
    imgs = [master.resize((s, s), Image.LANCZOS) for s in sizes]
    imgs[0].save(
        os.path.join(build_dir, 'icon.ico'),
        format='ICO',
        append_images=imgs[1:],
        sizes=[(s, s) for s in sizes],
    )
    print('wrote build/icon.png, resources/icon.png, build/icon.ico', sizes)


if __name__ == '__main__':
    main()
