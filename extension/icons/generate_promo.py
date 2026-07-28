#!/usr/bin/env python3
"""Generate the 440x280 Chrome Web Store promo tile.

Standard library only, like generate_icons.py, so the store assets stay
reproducible without an image dependency or a design tool. Text is drawn from
a small 5x7 bitmap font defined below -- there is no font renderer available,
and a promo tile without the product name on it is not worth much.

    python extension/icons/generate_promo.py
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from generate_icons import write_png  # noqa: E402

WIDTH, HEIGHT = 440, 280
SUPERSAMPLE = 3

BACKGROUND = (23, 23, 26, 255)
DISC = (194, 65, 12, 255)
NEEDLE_NORTH = (255, 255, 255, 255)
NEEDLE_SOUTH = (255, 255, 255, 110)
WORDMARK = (237, 237, 235, 255)
SUBMARK = (217, 154, 108, 255)

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
    """Blit a string into the pixel buffer at (x, y), top-left anchored."""
    cursor = x
    for char in text.upper():
        glyph = FONT.get(char, FONT[" "]).split("|")
        for row, bits in enumerate(glyph):
            for col, bit in enumerate(bits):
                if bit != "#":
                    continue
                for dy in range(scale):
                    for dx in range(scale):
                        px = cursor + col * scale + dx
                        py = y + row * scale + dy
                        if 0 <= px < WIDTH and 0 <= py < HEIGHT:
                            pixels[py][px] = colour
        cursor += GLYPH_W * scale + tracking


def sample_mark(x: float, y: float, radius: float):
    """The compass mark: a disc with a needle, matching the extension icon."""
    if math.hypot(x, y) > radius:
        return None
    root_half = math.sqrt(0.5)
    u = (x + y) * root_half
    v = (x - y) * root_half
    length, width = radius * 0.78, radius * 0.20
    if abs(u) < length and abs(v) < width * (1.0 - abs(u) / length):
        return NEEDLE_NORTH if u < 0 else NEEDLE_SOUTH
    return DISC


def render() -> list:
    pixels = [[BACKGROUND for _ in range(WIDTH)] for _ in range(HEIGHT)]

    # Compass mark, supersampled for smooth edges.
    centre_x, centre_y, radius = 108.0, HEIGHT / 2, 78.0
    for py in range(HEIGHT):
        for px in range(WIDTH):
            if math.hypot(px - centre_x, py - centre_y) > radius + 2:
                continue
            totals = [0, 0, 0, 0]
            hits = 0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    x = px + (sx + 0.5) / SUPERSAMPLE - centre_x
                    y = py + (sy + 0.5) / SUPERSAMPLE - centre_y
                    colour = sample_mark(x, y, radius)
                    if colour is None:
                        colour = BACKGROUND
                    for channel in range(4):
                        totals[channel] += colour[channel]
                    hits += 1
            pixels[py][px] = tuple(value // hits for value in totals)

    # Wordmark, left-aligned beside the mark and vertically centred on it.
    # Scale 5 keeps "COMPASS" inside the 440px width with room to spare.
    text_x = 214
    draw_text(pixels, "COMPASS", text_x, 104, scale=5, colour=WORDMARK, tracking=4)
    draw_text(pixels, "ECONOMIC CALENDAR", text_x, 152, scale=2, colour=SUBMARK, tracking=2)

    rule_width = max(
        text_width("COMPASS", 5, 4),
        text_width("ECONOMIC CALENDAR", 2, 2),
    )
    for px in range(text_x, min(WIDTH, text_x + rule_width)):
        pixels[176][px] = (60, 60, 66, 255)

    return [bytes(b for pixel in row for b in pixel) for row in pixels]


def main() -> None:
    target = Path(__file__).resolve().parent / "promo_440x280.png"
    write_png(target, WIDTH, HEIGHT, render())
    print(f"wrote {target.name} ({target.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
