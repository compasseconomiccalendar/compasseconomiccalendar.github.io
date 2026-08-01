#!/usr/bin/env python3
"""Package the extension into a Chrome Web Store upload zip.

Validates first, then zips. Development files are excluded: a reviewer seeing
test fixtures and build scripts is needless friction, and none of it is used
at runtime.

    python scripts/package_extension.py
    python scripts/package_extension.py --check    # validate only
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
EXTENSION_DIR = REPO_ROOT / "extension"
DIST_DIR = REPO_ROOT / "dist"

# Not shipped to users. package.json only marks the sources as ES modules for
# `node --test`; the promo tile is uploaded to the store listing separately,
# not bundled in the extension.
EXCLUDED_NAMES = {
    "package.json",
    "README.md",
    ".DS_Store",
    "promo_440x280.png",
    # Design master the icons are derived from. Shipping it would add ~34KB
    # to every install for a file nothing loads.
    "compass logo 512.png",
}
EXCLUDED_DIRS = {"test", "__pycache__", "node_modules"}
EXCLUDED_SUFFIXES = {".py", ".md", ".zip"}

# MV3 bans remote code. Fetching remote *data* is fine; loading remote logic
# or styles is not, and is a known rejection reason (RESEARCH.md section 5).
REMOTE_ASSET = re.compile(
    r"""<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["'](https?:)?//""",
    re.IGNORECASE,
)


def included(path: Path) -> bool:
    relative = path.relative_to(EXTENSION_DIR)
    if any(part in EXCLUDED_DIRS for part in relative.parts):
        return False
    if path.name in EXCLUDED_NAMES:
        return False
    return path.suffix.lower() not in EXCLUDED_SUFFIXES


def collect() -> list:
    return sorted(
        path
        for path in EXTENSION_DIR.rglob("*")
        if path.is_file() and included(path)
    )


def validate(manifest: dict, files: list) -> list:
    """Return a list of problems; empty means the package is shippable."""
    problems: list = []
    packaged = {path.relative_to(EXTENSION_DIR).as_posix() for path in files}

    if manifest.get("manifest_version") != 3:
        problems.append("manifest_version must be 3")

    for field in ("name", "version", "description"):
        if not manifest.get(field):
            problems.append(f"manifest is missing {field}")

    # The store truncates long descriptions in listings.
    description = manifest.get("description", "")
    if len(description) > 132:
        problems.append(f"description is {len(description)} chars; limit is 132")

    # Every file the manifest points at must actually be in the zip.
    referenced = list(manifest.get("icons", {}).values())
    for key in ("background", "action", "options_ui"):
        section = manifest.get(key, {})
        for field in ("service_worker", "default_popup", "page"):
            if section.get(field):
                referenced.append(section[field])

    for reference in referenced:
        if reference not in packaged:
            problems.append(f"manifest references {reference}, which is not packaged")

    # Anything imported by a packaged script must be packaged too.
    for path in files:
        if path.suffix != ".js":
            continue
        source = path.read_text(encoding="utf-8")
        for match in re.finditer(r'from\s+"(\.[^"]+)"', source):
            target = (path.parent / match.group(1)).resolve()
            try:
                relative = target.relative_to(EXTENSION_DIR).as_posix()
            except ValueError:
                problems.append(f"{path.name} imports outside extension/: {match.group(1)}")
                continue
            if relative not in packaged:
                problems.append(f"{path.name} imports {relative}, which is not packaged")

    for path in files:
        if path.suffix in (".html", ".js"):
            if REMOTE_ASSET.search(path.read_text(encoding="utf-8")):
                problems.append(
                    f"{path.name} loads a remote script or stylesheet -- "
                    "MV3 forbids remote code"
                )

    if not any(path.name == "manifest.json" for path in files):
        problems.append("manifest.json is not in the package")

    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description="Package the extension for the Web Store.")
    parser.add_argument("--check", action="store_true", help="validate without writing a zip")
    parser.add_argument("--out", type=Path, default=None, help="output zip path")
    args = parser.parse_args()

    manifest = json.loads((EXTENSION_DIR / "manifest.json").read_text(encoding="utf-8"))
    files = collect()
    problems = validate(manifest, files)

    print(f"Compass Economic Calendar v{manifest.get('version', '?')}")
    print(f"{len(files)} file(s) to package:\n")
    total = 0
    for path in files:
        size = path.stat().st_size
        total += size
        print(f"  {path.relative_to(EXTENSION_DIR).as_posix():<34} {size:>7,} B")

    skipped = sorted(
        path.relative_to(EXTENSION_DIR).as_posix()
        for path in EXTENSION_DIR.rglob("*")
        if path.is_file() and not included(path)
    )
    if skipped:
        print(f"\nExcluded ({len(skipped)}): {', '.join(skipped)}")

    if problems:
        print("\nNOT shippable:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1

    print(f"\nValidation passed. Uncompressed total {total:,} B.")
    if args.check:
        return 0

    version = manifest.get("version", "0.0.0")
    target = args.out or DIST_DIR / f"compass-economic-calendar-v{version}.zip"
    target.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            archive.write(path, path.relative_to(EXTENSION_DIR).as_posix())

    print(f"Wrote {target.relative_to(REPO_ROOT)} ({target.stat().st_size:,} B)")
    print("Upload this at https://chrome.google.com/webstore/devconsole")
    return 0


if __name__ == "__main__":
    sys.exit(main())
