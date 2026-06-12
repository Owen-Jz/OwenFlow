# OwenFlow app icon generator.
# Mark: a bold geometric "O" (for Owen) whose ring is broken by a horizontal
# waveform band — three rounded bars in the gap. Red -> warm-orange gradient
# (#ff2d3a -> #ff7a45) on a near-black warm rounded-square tile (#16100f).
# Run: py -3.13 scripts/make-icon.py
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = 1024
SS = 4  # supersample factor for crisp antialiased masks
BIG = MASTER * SS

RED = (0xFF, 0x2D, 0x3A)
ORANGE = (0xFF, 0x7A, 0x45)
BG = (0x16, 0x10, 0x0F)

# Geometry (1024 design grid). Ring weights tuned to stay readable at 16px.
CX = CY = 512
R_OUT = 350          # O ring outer radius
STROKE = 118         # O ring stroke weight
R_IN = R_OUT - STROKE
GAP_HALF = 118       # half-height of the horizontal waveform band that breaks the O
BAR_W = 92           # waveform bar width
BAR_STEP = 156       # distance between bar centers
BAR_H = (200, 330, 200)  # side, center, side bar heights


def rounded_square_mask() -> Image.Image:
    m = Image.new('L', (BIG, BIG), 0)
    d = ImageDraw.Draw(m)
    pad = int(0.04 * BIG)  # small transparent margin so taskbar/tray doesn't clip
    radius = int(0.225 * BIG)
    d.rounded_rectangle([pad, pad, BIG - pad, BIG - pad], radius=radius, fill=255)
    return m.resize((MASTER, MASTER), Image.LANCZOS)


def mark_mask() -> Image.Image:
    """The O-with-waveform mark as an antialiased alpha mask."""
    m = Image.new('L', (BIG, BIG), 0)
    d = ImageDraw.Draw(m)
    s = BIG / 1024

    cx, cy = CX * s, CY * s

    # 1) the O: filled annulus
    d.ellipse([cx - R_OUT * s, cy - R_OUT * s, cx + R_OUT * s, cy + R_OUT * s], fill=255)
    d.ellipse([cx - R_IN * s, cy - R_IN * s, cx + R_IN * s, cy + R_IN * s], fill=0)

    # 2) break it: punch the horizontal waveform band out of the ring
    d.rectangle([0, cy - GAP_HALF * s, BIG, cy + GAP_HALF * s], fill=0)

    # 3) round caps on the four arc ends (centerline radius x band edge)
    r_mid = (R_OUT + R_IN) / 2
    dx = (r_mid**2 - GAP_HALF**2) ** 0.5
    capr = STROKE / 2 * s
    for ex in (cx - dx * s, cx + dx * s):
        for ey in (cy - GAP_HALF * s, cy + GAP_HALF * s):
            d.ellipse([ex - capr, ey - capr, ex + capr, ey + capr], fill=255)

    # 4) waveform bars in the gap (center bar taller, pokes past the band)
    for i, h in enumerate(BAR_H):
        bx = cx + (i - 1) * BAR_STEP * s
        half_w = BAR_W / 2 * s
        half_h = h / 2 * s
        d.rounded_rectangle(
            [bx - half_w, cy - half_h, bx + half_w, cy + half_h], radius=half_w, fill=255
        )

    return m.resize((MASTER, MASTER), Image.LANCZOS)


def diagonal_gradient(bbox: tuple[int, int, int, int]) -> Image.Image:
    """Red (top-left) -> warm orange (bottom-right), normalized across bbox."""
    n = 256
    x0, y0, x1, y1 = (v * n / MASTER for v in bbox)
    lo, hi = x0 + y0, x1 + y1
    g = Image.new('RGB', (n, n))
    px = g.load()
    for y in range(n):
        for x in range(n):
            t = min(1.0, max(0.0, (x + y - lo) / (hi - lo)))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(RED, ORANGE))
    return g.resize((MASTER, MASTER), Image.BICUBIC)


def build() -> Image.Image:
    bg_mask = rounded_square_mask()
    glyph = mark_mask()
    grad = diagonal_gradient(glyph.getbbox() or (0, 0, MASTER, MASTER))

    icon = Image.new('RGBA', (MASTER, MASTER), (0, 0, 0, 0))
    # tile
    tile = Image.new('RGBA', (MASTER, MASTER), BG + (255,))
    icon.paste(tile, (0, 0), bg_mask)

    # soft red glow behind the mark (premium feel; invisible at tiny sizes)
    glow = Image.new('RGBA', (MASTER, MASTER), (0, 0, 0, 0))
    glow_layer = Image.new('RGBA', (MASTER, MASTER), RED + (0,))
    glow_alpha = glyph.filter(ImageFilter.GaussianBlur(70)).point(lambda a: int(a * 0.36))
    glow_layer.putalpha(glow_alpha)
    glow.alpha_composite(glow_layer)
    # keep glow inside the tile
    glow.putalpha(
        Image.composite(glow.getchannel('A'), Image.new('L', (MASTER, MASTER), 0), bg_mask)
    )
    icon.alpha_composite(glow)

    # gradient mark
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
