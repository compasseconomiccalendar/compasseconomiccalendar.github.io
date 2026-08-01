#!/usr/bin/env python3
"""Generate the 440x280 Chrome Web Store promo tile from the source logo.

The mark is the same artwork the icons come from, so the tile cannot drift
away from what users see in the toolbar. The wordmark is drawn from a small
5x7 bitmap font defined below -- bundling a real typeface for two words would
be heavier than the tile itself, and a promo tile without the product name on
it is not worth much.

    python3 -m pip install --user Pillow
    python extension/icons/generate_promo.py
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - tooling guard
    sys.exit("Pillow is required: python3 -m pip install --user Pillow")

ICONS_DIR = Path(__file__).resolve().parent
SOURCE = ICONS_DIR / "compass logo 512.png"
TARGET = ICONS_DIR / "promo_440x280.png"

WIDTH, HEIGHT = 440, 280

# Sampled from the logo's own plate so the tile reads as one piece of artwork.
BACKGROUND = (18, 18, 20, 255)
WORDMARK = (237, 237, 235, 255)
SUBMARK = (240, 138, 42, 255)   # the needle's orange
RULE = (60, 60, 66, 255)

MARK_SIZE = 176
MARK_X, MARK_Y = 22, (HEIGHT - MARK_SIZE) // 2
TEXT_X = 214
RIGHT_MARGIN = 20

# Real typefaces, best first. Weights are picked for a display line rather
# than body text; Avenir Next Demi Bold reads as a product wordmark where
# Helvetica Regular reads as a caption.
FONT_CANDIDATES = [
    ("/System/Library/Fonts/Avenir Next.ttc", 5),   # Demi Bold face in the collection
    ("/System/Library/Fonts/HelveticaNeue.ttc", 2),
    ("/System/Library/Fonts/Helvetica.ttc", 1),
    ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 0),
]


def load_font(size: int):
    """First available system typeface at the requested size."""
    for path, index in FONT_CANDIDATES:
        if not Path(path).exists():
            continue
        try:
            return ImageFont.truetype(path, size, index=index)
        except (OSError, ValueError):
            continue
    sys.exit(
        "no usable system font found; edit FONT_CANDIDATES for this platform"
    )


def draw_tracked(draw, xy, text, font, fill, tracking=0.0):
    """Draw text with letter-spacing, which Pillow does not support natively.

    A small-caps line set solid reads as a default; the spacing is what makes
    it look deliberate. Returns the drawn width.
    """
    x, y = xy
    for char in text:
        draw.text((x, y), char, font=font, fill=fill)
        x += draw.textlength(char, font=font) + tracking
    return x - xy[0] - (tracking if text else 0)


def measure_tracked(draw, text, font, tracking=0.0) -> float:
    if not text:
        return 0.0
    return sum(draw.textlength(c, font=font) for c in text) + tracking * (len(text) - 1)


def main() -> int:
    if not SOURCE.exists():
        sys.exit(f"source artwork not found: {SOURCE.name}")

    tile = Image.new("RGBA", (WIDTH, HEIGHT), BACKGROUND)

    mark = Image.open(SOURCE).convert("RGBA").resize(
        (MARK_SIZE, MARK_SIZE), Image.LANCZOS
    )
    # Pasted with itself as the mask so the logo's rounded corners stay
    # transparent against the tile rather than showing a square edge.
    tile.paste(mark, (MARK_X, MARK_Y), mark)

    draw = ImageDraw.Draw(tile)
    wordmark_font = load_font(44)
    submark_font = load_font(14)

    lines = [
        ("Compass", 96, wordmark_font, WORDMARK, 0.0),
        ("ECONOMIC CALENDAR", 152, submark_font, SUBMARK, 2.4),
    ]

    # A tile whose wordmark runs off the edge is worse than none, and the
    # overflow is only obvious once rendered -- so fail instead of shipping it.
    widths = []
    for text, _, font, _, tracking in lines:
        width = measure_tracked(draw, text, font, tracking)
        widths.append(width)
        if TEXT_X + width > WIDTH - RIGHT_MARGIN:
            sys.exit(
                f"{text!r} ends at {TEXT_X + width:.0f}px, "
                f"past the {WIDTH - RIGHT_MARGIN}px limit"
            )

    for text, y, font, colour, tracking in lines:
        draw_tracked(draw, (TEXT_X, y), text, font, colour, tracking)

    draw.line(
        [(TEXT_X, 180), (TEXT_X + max(widths), 180)], fill=RULE, width=1
    )

    tile.convert("RGB").save(TARGET, "PNG", optimize=True)
    print(f"wrote {TARGET.name} ({TARGET.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
