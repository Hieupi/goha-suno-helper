"""Draw the GOHA Suno Helper toolbar icons (16/32/48/128 px) into ../icons/.

Look: the channel's palette, not Suno's — an indigo (藍) tile carrying a vermilion (朱)
hanko-style seal with a white sound wave over a download arrow; "G" (GOHA) in the corner at
48 px and up. The motif sits high and left because Chrome's status badge (ON / KEY / !)
covers the bottom-right of the icon. Each size is drawn at 8x and scaled down so edges
stay smooth; the 16 px icon drops the letters, which would only blur.

Run:  python extensions/jr-suno-helper/tools/make_icons.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ICONS_DIR = Path(__file__).resolve().parents[1] / "icons"
SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 8
INDIGO = (27, 42, 74, 255)
INDIGO_EDGE = (47, 66, 110, 255)
VERMILION = (217, 65, 43, 255)
WHITE = (255, 255, 255, 255)
LABEL_FROM_PX = 48  # below this the "G" (GOHA) label is unreadable
DETAIL_FROM_PX = 32  # below this only three bold bars survive (no arrow)
FONT_CANDIDATES = ("C:/Windows/Fonts/seguibl.ttf", "C:/Windows/Fonts/arialbd.ttf", "DejaVuSans-Bold.ttf")


def _font(pixels: int) -> ImageFont.ImageFont:
    for candidate in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(candidate, pixels)
        except OSError:
            continue
    return ImageFont.load_default()


def _tile(draw: ImageDraw.ImageDraw, side: int) -> None:
    radius = side * 0.22
    draw.rounded_rectangle((0, 0, side - 1, side - 1), radius=radius, fill=INDIGO_EDGE)
    inset = side * 0.03
    draw.rounded_rectangle((inset, inset, side - 1 - inset, side - 1 - inset), radius=radius * 0.9, fill=INDIGO)


def _seal(draw: ImageDraw.ImageDraw, side: int, with_label: bool, detailed: bool) -> None:
    """Vermilion seal: a sound wave (bars) resting on a download arrow (arrow dropped at 16 px)."""
    diameter = side * (0.62 if with_label else 0.8)
    cx = side * (0.42 if with_label else 0.5)
    cy = side * (0.40 if with_label else 0.46)
    r = diameter / 2
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=VERMILION)
    bar_w = r * (0.18 if detailed else 0.26)
    gap = r * (0.12 if detailed else 0.2)
    heights = (0.45, 0.85, 1.1, 0.7, 0.4) if detailed else (0.6, 1.1, 0.6)
    total = len(heights) * bar_w + (len(heights) - 1) * gap
    x = cx - total / 2
    wave_mid = cy - (r * 0.18 if detailed else 0)
    for h in heights:
        half = r * 0.42 * h
        draw.rounded_rectangle((x, wave_mid - half, x + bar_w, wave_mid + half), radius=bar_w / 2, fill=WHITE)
        x += bar_w + gap
    if not detailed:
        return
    # Download arrow under the wave: a short chevron pointing down.
    ay = cy + r * 0.48
    aw = r * 0.34
    stroke = max(int(bar_w * 0.9), 1)
    draw.line((cx - aw, ay - aw * 0.55, cx, ay, cx + aw, ay - aw * 0.55), fill=WHITE, width=stroke, joint="curve")


def _label(draw: ImageDraw.ImageDraw, side: int) -> None:
    font = _font(int(side * 0.27))
    draw.text((side * 0.10, side * 0.95), "G", font=font, fill=WHITE, anchor="ls")


def draw_icon(size: int) -> Image.Image:
    side = size * SUPERSAMPLE
    image = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    with_label = size >= LABEL_FROM_PX
    _tile(draw, side)
    _seal(draw, side, with_label, size >= DETAIL_FROM_PX)
    if with_label:
        _label(draw, side)
    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    ICONS_DIR.mkdir(exist_ok=True)
    for size in SIZES:
        draw_icon(size).save(ICONS_DIR / f"icon{size}.png")
        print(f"wrote {ICONS_DIR / f'icon{size}.png'}")


if __name__ == "__main__":
    main()
