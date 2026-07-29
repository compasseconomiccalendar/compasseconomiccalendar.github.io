#!/usr/bin/env python3
"""Repoint the project at a different published origin.

The site URL appears in the extension manifest, the extension config, the
published web pages, the ingestion job's user agent and the docs. Changing it
by hand means finding every one; this does the whole switch atomically so the
manifest and the privacy policy can never disagree about where data goes.

Typical reasons to run it:
  * moving the repo to a GitHub organisation, so the published URL no longer
    contains a personal username
  * putting a custom domain in front of GitHub Pages

    python scripts/set_site_url.py https://compass-calendar.github.io/compasseconomiccalendar
    python scripts/set_site_url.py https://compasscalendar.app --repo https://github.com/compass-calendar/compasseconomiccalendar
    python scripts/set_site_url.py --show
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Every file that hardcodes the origin. Keeping this list here is the point:
# a new file that embeds the URL should be added, and --show will reveal any
# that were missed.
TRACKED = [
    "extension/manifest.json",
    "extension/src/config.js",
    "extension/README.md",
    "extension/options/options.html",
    "ingestion/build_calendar.py",
    "web/privacy.html",
    "web/index.html",
    "README.md",
]

REPO_PATTERN = re.compile(r"https://github\.com/[A-Za-z0-9._\-]+/[A-Za-z0-9._\-]+")


def current_values() -> tuple:
    """The site and repo URLs currently in use, read from the manifest and job."""
    manifest = (REPO_ROOT / "extension/manifest.json").read_text(encoding="utf-8")
    site = re.search(r"https://[A-Za-z0-9.\-]+\.github\.io/[A-Za-z0-9._\-]+", manifest)

    build = (REPO_ROOT / "ingestion/build_calendar.py").read_text(encoding="utf-8")
    repo = REPO_PATTERN.search(build)
    return (site.group(0) if site else None, repo.group(0) if repo else None)


def strip_scheme(url: str) -> str:
    return re.sub(r"^https?://", "", url) if url else url


def variants(site: str, repo: str) -> list:
    """Every spelling of the URLs that appears in the tree."""
    values = []
    for url in (site, repo):
        if not url:
            continue
        values.append(url)
        bare = strip_scheme(url)
        if bare != url:
            values.append(bare)
    return values


def scan() -> dict:
    """Every tracked file's occurrences, plus any untracked file that has some."""
    site, repo = current_values()
    found = {}
    for path in sorted(REPO_ROOT.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(REPO_ROOT).as_posix()
        if relative.startswith((".git/", "dist/", "output/", "venv/", "data/")):
            continue
        if path.suffix not in {".py", ".js", ".json", ".html", ".md", ".yml", ".css"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        # The privacy policy prints the host without a scheme for readability
        # ("compasseconomiccalendar.github.io/..."), so both forms have to be counted and
        # rewritten or the switch leaves the username visible in exactly the
        # document this exists to clean up.
        hits = sum(
            text.count(value) for value in variants(site, repo) if value
        )
        if hits:
            found[relative] = hits
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description="Repoint the published site URL.")
    parser.add_argument("site", nargs="?", help="new published base URL, no trailing slash")
    parser.add_argument("--repo", help="new repository URL, if it also moved")
    parser.add_argument("--show", action="store_true", help="list current URLs and where they appear")
    args = parser.parse_args()

    old_site, old_repo = current_values()
    if not old_site:
        print("Could not determine the current site URL from the manifest.", file=sys.stderr)
        return 1

    found = scan()
    if args.show or not args.site:
        print(f"site: {old_site}\nrepo: {old_repo}\n")
        print(f"{sum(found.values())} occurrence(s) across {len(found)} file(s):")
        for relative, hits in sorted(found.items()):
            untracked = "" if relative in TRACKED else "   <- not in TRACKED"
            print(f"  {hits:>3}  {relative}{untracked}")
        if not args.site:
            print("\nPass a new URL to rewrite them.")
        return 0

    new_site = args.site.rstrip("/")
    new_repo = args.repo.rstrip("/") if args.repo else None

    changed = 0
    for relative in sorted(found):
        path = REPO_ROOT / relative
        text = path.read_text(encoding="utf-8")
        # Longest first, so the full URL is replaced before the bare host --
        # otherwise the scheme is left stranded in front of the new host.
        updated = text.replace(old_site, new_site)
        updated = updated.replace(strip_scheme(old_site), strip_scheme(new_site))
        if new_repo and old_repo:
            updated = updated.replace(old_repo, new_repo)
            updated = updated.replace(strip_scheme(old_repo), strip_scheme(new_repo))
        if updated != text:
            path.write_text(updated, encoding="utf-8")
            changed += 1
            print(f"  updated {relative}")

    print(f"\nsite: {old_site}\n  ->  {new_site}")
    if new_repo:
        print(f"repo: {old_repo}\n  ->  {new_repo}")
    print(f"\n{changed} file(s) rewritten.")
    print(
        "\nNext: rebuild the feed so the published JSON carries the new URLs,\n"
        "re-run scripts/package_extension.py, and if this is a custom domain\n"
        "add a CNAME file to web/ so GitHub Pages serves it."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
