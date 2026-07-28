#!/usr/bin/env python3
"""Generate the extension icons: a compass needle on a filled disc.

Written with the standard library only (zlib + struct emit the PNG), so the
icons are reproducible without adding an image dependency to the project.

    python extension/icons/generate_icons.py
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 4  # averaged down for anti-aliasing

DISC = (194, 65, 12, 255)        # burnt orange, matches the popup's high-impact hue
NEEDLE_NORTH = (255, 255, 255, 255)
NEEDLE_SOUTH = (255, 255, 255, 110)
TRANSPARENT = (0, 0, 0, 0)


def sample(x: float, y: float, radius: float) -> tuple:
    """Colour one point, in coordinates centred on the disc."""
    if math.hypot(x, y) > radius:
        return TRANSPARENT

    # Rotate 45 degrees: u runs NE-SW along the needle, v across it.
    root_half = math.sqrt(0.5)
    u = (x + y) * root_half
    v = (x - y) * root_half

    length = radius * 0.78
    width = radius * 0.20
    if abs(u) < length:
        # Lens shape: widest at the centre, tapering to each point.
        if abs(v) < width * (1.0 - abs(u) / length):
            return NEEDLE_NORTH if u < 0 else NEEDLE_SOUTH
    return DISC


def render(size: int) -> list:
    scale = size * SUPERSAMPLE
    radius = scale / 2 - SUPERSAMPLE * 0.5
    centre = scale / 2

    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            totals = [0, 0, 0, 0]
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    x = px * SUPERSAMPLE + sx + 0.5 - centre
                    y = py * SUPERSAMPLE + sy + 0.5 - centre
                    pixel = sample(x, y, radius)
                    for channel in range(4):
                        totals[channel] += pixel[channel]
            count = SUPERSAMPLE * SUPERSAMPLE
            row.extend(value // count for value in totals)
        rows.append(bytes(row))
    return rows


def write_png(path: Path, width: int, height: int, rows: list) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\x00" + row for row in rows)  # filter type 0 per scanline
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    out_dir = Path(__file__).resolve().parent
    for size in SIZES:
        target = out_dir / f"icon{size}.png"
        write_png(target, size, size, render(size))
        print(f"wrote {target.name} ({target.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
