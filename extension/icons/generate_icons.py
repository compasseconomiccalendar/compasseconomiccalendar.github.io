#!/usr/bin/env python3
"""Derive the extension's icon sizes from the source logo.

The 512px artwork is the master; every shipped size is downscaled from it so
the set can never drift out of sync with the brand mark.

Requires Pillow, which is a tooling dependency only -- the extension itself
ships the generated PNGs and has no dependencies at all:

    python3 -m pip install --user Pillow
    python extension/icons/generate_icons.py
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

# Chrome uses 16 in the toolbar and favicons, 32 on Windows, 48 on the
# extensions page, and 128 in the Web Store and the install dialog.
SIZES = (16, 32, 48, 128)

# The artwork carries about 30% padding around the compass, which reads fine
# at 128 and turns the needle into an unreadable sliver at 16. Small sizes are
# therefore cropped toward the content, keeping only a hint of the plate --
# the same trick a hand-tuned icon set uses.
CROP_AT_OR_BELOW = 32
CROP_MARGIN = 0.13  # of the content box, kept on every side


def content_box(image: "Image.Image") -> tuple:
    """Bounding box of the artwork inside its background plate."""
    width, height = image.size
    pixels = image.load()
    background = pixels[width // 2, 12][:3]

    def differs(pixel) -> bool:
        return pixel[3] > 10 and sum(
            abs(a - b) for a, b in zip(pixel[:3], background)
        ) > 40

    xs, ys = [], []
    for y in range(0, height, 2):
        for x in range(0, width, 2):
            if differs(pixels[x, y]):
                xs.append(x)
                ys.append(y)
    if not xs:
        return (0, 0, width, height)

    margin = int((max(xs) - min(xs)) * CROP_MARGIN)
    return (
        max(0, min(xs) - margin),
        max(0, min(ys) - margin),
        min(width, max(xs) + margin),
        min(height, max(ys) + margin),
    )


def load_master() -> "Image.Image":
    if not SOURCE.exists():
        sys.exit(f"source artwork not found: {SOURCE.name}")
    master = Image.open(SOURCE).convert("RGBA")
    if master.size != (512, 512):
        print(f"note: source is {master.size}, expected 512x512", file=sys.stderr)
    return master


def main() -> int:
    master = load_master()

    cropped = master.crop(content_box(master))

    for size in SIZES:
        source = cropped if size <= CROP_AT_OR_BELOW else master
        # LANCZOS keeps the needle and the thin compass ring legible at 16px,
        # where a cheaper filter turns both to mush.
        resized = source.resize((size, size), Image.LANCZOS)
        target = ICONS_DIR / f"icon{size}.png"
        resized.save(target, "PNG", optimize=True)
        print(f"wrote {target.name} ({target.stat().st_size} bytes)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
