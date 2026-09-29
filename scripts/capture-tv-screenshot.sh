#!/usr/bin/env bash
# Captures the connected Fire TV's screen for the Appstore listing:
#   scripts/capture-tv-screenshot.sh 01-pairing
# Saves store/fire-tv/screenshots/<name>.png as a 1920x1080 24-bit PNG (no
# transparency), which is what Amazon requires. Needs the Vega CLI and
# ImageMagick 7.
set -euo pipefail

cd "$(dirname "$0")/.."
name="${1:?usage: $0 <name>}"
device_file="/tmp/tandem-screenshot.png"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# gwsi-tool-screenshooter exits cleanly; plain screenshooter can hang.
vega device run-cmd -c "timeout 15 gwsi-tool-screenshooter $device_file" > /dev/null
vega device copy-from --source "$device_file" --destination "$work/raw.png" > /dev/null
mkdir -p store/fire-tv/screenshots
magick "$work/raw.png" -background "#111827" -alpha remove -alpha off -resize '1920x1080!' \
  PNG24:"store/fire-tv/screenshots/$name.png"
echo "Saved store/fire-tv/screenshots/$name.png"
