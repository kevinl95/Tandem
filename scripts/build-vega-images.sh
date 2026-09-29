#!/usr/bin/env bash
# Regenerates the Vega app's image assets from the sources in store/ (needs
# ImageMagick 7). The outputs are committed, so builds don't need this.
#
#   vega-app/assets/image/app_icon.png          512x512 package icon (Settings)
#   vega-app/assets/raw/SplashScreenImages.zip  static 1920x1080 splash screen
set -euo pipefail

cd "$(dirname "$0")/.."
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p vega-app/assets/image vega-app/assets/raw
magick -background none -density 384 store/vega/settings-icon.svg -resize 512x512 \
  -strip PNG32:vega-app/assets/image/app_icon.png

# The store icon's artwork, centered at full size on the app background color
# (#111827, which the artwork's own background already uses).
mkdir -p "$work/_loop"
magick -size 1920x1080 xc:"#111827" store/fire-tv/app-icon-1280x720.png -gravity center \
  -composite -strip PNG24:"$work/_loop/loop00000.png"
# Width, height and fps, then the part definition Vega's animation service expects.
printf '1920 1080 30\nc 0 0 _loop\n' > "$work/desc.txt"
rm -f vega-app/assets/raw/SplashScreenImages.zip
(cd "$work" && zip -q -X "$OLDPWD/vega-app/assets/raw/SplashScreenImages.zip" _loop/loop00000.png desc.txt)

echo "Wrote vega-app/assets/image/app_icon.png and vega-app/assets/raw/SplashScreenImages.zip"
