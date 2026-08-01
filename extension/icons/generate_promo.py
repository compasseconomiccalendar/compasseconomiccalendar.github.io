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
    from PIL import Image
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

# 5x7 glyphs, rows top to bottom. Only uppercase and space are needed.
FONT = {
    "A": ".###.|#...#|#...#|#####|#...#|#...#|#...#",
    "B": "####.|#...#|#...#|####.|#...#|#...#|####.",
    "C": ".###.|#...#|#....|#....|#....|#...#|.###.",
    "D": "####.|#...#|#...#|#...#|#...#|#...#|####.",
    "E": "#####|#....|#....|####.|#....|#....|#####",
    "F": "#####|#....|#....|####.|#....|#....|#....",
    "G": ".###.|#...#|#....|#.###|#...#|#...#|.###.",
    "H": "#...#|#...#|#...#|#####|#...#|#...#|#...#",
    "I": "#####|..#..|..#..|..#..|..#..|..#..|#####",
    "J": "..###|...#.|...#.|...#.|...#.|#..#.|.##..",
    "K": "#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#",
    "L": "#....|#....|#....|#....|#....|#....|#####",
    "M": "#...#|##.##|#.#.#|#...#|#...#|#...#|#...#",
    "N": "#...#|##..#|#.#.#|#..##|#...#|#...#|#...#",
    "O": ".###.|#...#|#...#|#...#|#...#|#...#|.###.",
    "P": "####.|#...#|#...#|####.|#....|#....|#....",
    "Q": ".###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#",
    "R": "####.|#...#|#...#|####.|#.#..|#..#.|#...#",
    "S": ".####|#....|#....|.###.|....#|....#|####.",
    "T": "#####|..#..|..#..|..#..|..#..|..#..|..#..",
    "U": "#...#|#...#|#...#|#...#|#...#|#...#|.###.",
    "V": "#...#|#...#|#...#|#...#|#...#|.#.#.|..#..",
    "W": "#...#|#...#|#...#|#...#|#.#.#|##.##|#...#",
    "X": "#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#",
    "Y": "#...#|#...#|.#.#.|..#..|..#..|..#..|..#..",
    "Z": "#####|....#|...#.|..#..|.#...|#....|#####",
    " ": ".....|.....|.....|.....|.....|.....|.....",
}

GLYPH_W, GLYPH_H = 5, 7


def text_width(text: str, scale: int, tracking: int) -> int:
    return len(text) * (GLYPH_W * scale + tracking) - tracking


def draw_text(pixels, text, x, y, scale, colour, tracking):
    """Blit a string into the pixel access object, top-left anchored."""
    cursor = x
    for char in text.upper():
        glyph = FONT.get(char, FONT[" "]).split("|")
        for row, bits in enumerate(glyph):
            for col, bit in enumerate(bits):
                if bit != "#":
                    continue
                for dy in range(scale):
                    for dx in range(scale):
                        px, py = cursor + col * scale + dx, y + row * scale + dy
                        if 0 <= px < WIDTH and 0 <= py < HEIGHT:
                            pixels[px, py] = colour
        cursor += GLYPH_W * scale + tracking


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

    lines = [
        ("COMPASS", 104, 5, WORDMARK, 3),
        ("ECONOMIC CALENDAR", 152, 2, SUBMARK, 1),
    ]

    # A tile whose wordmark runs off the edge is worse than none, and the
    # overflow is only obvious once rendered -- so fail instead of shipping it.
    for text, _, scale, _, tracking in lines:
        end = TEXT_X + text_width(text, scale, tracking)
        if end > WIDTH - RIGHT_MARGIN:
            sys.exit(
                f"{text!r} ends at {end}px, past the {WIDTH - RIGHT_MARGIN}px limit"
            )

    pixels = tile.load()
    for text, y, scale, colour, tracking in lines:
        draw_text(pixels, text, TEXT_X, y, scale, colour, tracking)

    rule_width = max(
        text_width(text, scale, tracking) for text, _, scale, _, tracking in lines
    )
    for px in range(TEXT_X, min(WIDTH, TEXT_X + rule_width)):
        pixels[px, 176] = RULE

    tile.convert("RGB").save(TARGET, "PNG", optimize=True)
    print(f"wrote {TARGET.name} ({TARGET.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
