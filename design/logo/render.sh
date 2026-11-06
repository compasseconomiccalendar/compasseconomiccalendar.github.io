#!/bin/zsh
# Renders the extension icons and the store promo tile from the SVG/HTML
# sources in this folder, using headless Chrome (no other dependencies).
#
#   design/logo/render.sh
#
# logo.svg is the master; logo-16.svg is a hand-tuned variant for the 16px
# toolbar size, where the master's needle is too thin to read.
set -euo pipefail
HERE=${0:A:h}
ROOT=${HERE:h:h}
ICONS=$ROOT/extension/icons
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

shoot() {  # shoot <page> <width> <height> <out>
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --default-background-color=00000000 --force-device-scale-factor=1 \
    --window-size=$2,$3 --user-data-dir="$TMP/profile" \
    --screenshot="$4" "file://$1" >/dev/null 2>&1
}

for size in 16 32 48 128; do
  src=$HERE/logo.svg
  [[ $size == 16 ]] && src=$HERE/logo-16.svg
  page=$TMP/icon$size.html
  print -r -- "<html><body style='margin:0'><img src='file://$src' width=$size height=$size style='display:block'></body></html>" > $page
  shoot $page $size $size $ICONS/icon$size.png
  echo "icons/icon$size.png"
done

shoot $HERE/promo.html 440 280 $ROOT/design/store/promo_440x280.png
echo "design/store/promo_440x280.png"

# Store listing icon: Google asks for 96x96 artwork centred in 128x128 with
# transparent padding, unlike the edge-to-edge icon128.png the extension ships.
page=$TMP/store-icon.html
print -r -- "<html><body style='margin:0'><img src='file://$HERE/logo.svg' style='display:block;width:96px;height:96px;margin:16px'></body></html>" > $page
shoot $page 128 128 $ROOT/design/store/store_icon_128.png
echo "design/store/store_icon_128.png"
