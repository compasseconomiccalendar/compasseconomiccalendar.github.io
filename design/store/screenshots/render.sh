#!/bin/zsh
# Renders the Chrome Web Store screenshots (1280x800) from the real extension.
#
#   design/store/screenshots/render.sh
#
# The extension is served with stub.js standing in for chrome.*, against a
# frozen copy of the feed (feed.json) and a fixed clock, so every run produces
# identical images. To re-shoot after a UI change, just run it again; to move
# the scene, change NOW or refresh feed.json from the live feed.
set -euo pipefail
HERE=${0:A:h}
ROOT=${HERE:h:h:h}
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
# Tuesday 10 Nov 2026, 7:42:48am ET: pre-market, 47 minutes before CPI.
NOW=${NOW:-2026-11-10T12:42:48Z}
PORT=${PORT:-8791}

TMP=$(mktemp -d)
cleanup() { [[ -n ${SERVER:-} ]] && kill $SERVER 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

# Serve a copy of the extension with the stub injected ahead of its scripts.
cp -R "$ROOT/extension" "$TMP/site"
cp "$HERE/stub.js" "$HERE/feed.json" "$TMP/site/"
for page in "$TMP/site/popup/popup.html" "$TMP/site/options/options.html"; do
  sed -i '' 's#<head>#<head><script src="/stub.js"></script>#' "$page"
done
python3 -m http.server $PORT --directory "$TMP/site" >/dev/null 2>&1 &
SERVER=$!
until curl -s -o /dev/null "http://localhost:$PORT/feed.json"; do sleep 0.2; done

shoot() {  # shoot <out.png> <url> <width> <height> <scale>
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=$5 --window-size=$3,$4 \
    --virtual-time-budget=3000 --allow-file-access-from-files \
    --user-data-dir="$TMP/profile" --screenshot="$1" "$2" >/dev/null 2>&1
}

POPUP="http://localhost:$PORT/popup/popup.html?now=$NOW"
OPTIONS="http://localhost:$PORT/options/options.html?now=$NOW"
mkdir -p "$TMP/raw"

# Raw renders at 2x, so they stay sharp when scaled into the frame.
shoot "$TMP/raw/main.png"   "$POPUP&theme=dark&reminders=fred-jobless-claims-2026-11-12" 380 590 2
shoot "$TMP/raw/week.png"   "$POPUP&theme=light&groups=fomc,data"                  380 590 2
shoot "$TMP/raw/detail.png" "$POPUP&theme=dark&click=next&reminders=fred-cpi-2026-11-10" 380 590 2
shoot "$TMP/raw/hours.png"  "$POPUP&theme=light&click=market"                      380 590 2
# Full page, cropped to the Notifications card in the frame. (Scrolling
# instead catches the switches mid-transition.)
shoot "$TMP/raw/notify.png" "$OPTIONS&theme=dark"                                  760 1300 2

# The brief text shown in the mock notification is the extension's own output
# for that morning, not copy written for the screenshot.
BRIEF=$(cd "$ROOT/extension" && node --input-type=module -e '
import { readFileSync } from "node:fs";
import { buildBrief } from "./src/brief.js";
const feed = JSON.parse(readFileSync(process.argv[1], "utf8"));
const at = new Date(process.argv[2]);
at.setUTCHours(12, 0, 0, 0);  // 7:00am ET, the brief hour in the stub
const brief = buildBrief(feed.events, { now: at.getTime(), timeZone: "America/New_York", hour12: true });
console.log(brief.title);
console.log(brief.message);
' "$HERE/feed.json" "$NOW")
BRIEF_TITLE=$(print -r -- "$BRIEF" | head -1)
BRIEF_BODY=$(print -r -- "$BRIEF" | tail -1)

frame() {  # frame <out> <raw> <theme> <kicker> <headline> <sub> [wide] [crop] [ntitle] [nbody]
  local query
  query=$(python3 -c 'import sys, urllib.parse as u
keys = ["img", "theme", "kicker", "headline", "sub", "wide", "crop", "ntitle", "nbody"]
print(u.urlencode({k: v for k, v in zip(keys, sys.argv[1:]) if v}))' \
    "file://$TMP/raw/$2" "$3" "$4" "$5" "$6" "${7:-}" "${8:-}" "${9:-}" "${10:-}")
  shoot "$HERE/$1" "file://$HERE/frame.html?$query" 1280 800 1
  echo "design/store/screenshots/$1"
}

frame 1-countdown.png main.png dark \
  "Never miss a release" \
  "Every market-moving|event, counted down." \
  "FOMC, CPI, jobs, Treasury auctions and futures rolls, with a live countdown to the next high-impact release."
frame 2-week.png week.png light \
  "Plan the week" \
  "See the busy days|before they arrive." \
  "Five trading days at a glance, filtered to what you trade, with holidays and early closes marked."
frame 3-detail.png detail.png dark \
  "Context, not noise" \
  "Know how markets|usually react." \
  "How far markets have moved on past releases, the time in your zone and in Eastern, and the official source one click away."
frame 4-hours.png hours.png light \
  "Market hours" \
  "Open, closed or|pre-market, at a glance." \
  "Equity and CME index futures sessions in your own time zone, including holidays and half days."
frame 5-alerts.png notify.png dark \
  "Alerts your way" \
  "Alerts that fit|your day." \
  "Warnings before the events you choose, a morning brief each weekday, and reminders on any single event." \
  1 "470,770" "$BRIEF_TITLE" "$BRIEF_BODY"
