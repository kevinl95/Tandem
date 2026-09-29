# Store assets

Source artwork for the Amazon Appstore listing and the Vega app. Title: **Tandem Screen Share**.

| File | Used for | Amazon's spec |
|---|---|---|
| `fire-tv/app-icon-1280x720.png` | Fire TV app icon (the tile in app rows) | 1280×720 PNG, no transparency; keep content within the centered 882×448 safe area |
| `fire-tv/background-1920x1080.png` | Fire TV background image (behind the listing's details) | 1920×1080 JPG or 24-bit PNG, no transparency; keep content within the 1214×830 safe area |
| `vega/settings-icon.svg` | Source for the Vega package icon shown in Settings > Applications | 512×512 PNG, 1 MB max, light solid glyph |

`scripts/build-vega-images.sh` (ImageMagick 7) regenerates the Vega app's committed image assets from these files:

- `vega-app/assets/image/app_icon.png`: the package icon, from `vega/settings-icon.svg`.
- `vega-app/assets/raw/SplashScreenImages.zip`: a static 1920×1080 splash, which is the app icon artwork centered on the app background (#111827).

`fire-tv/screenshots/` holds the listing screenshots (1920×1080, 24-bit PNG, no transparency; Amazon wants 3–10): the pairing screen, the approval prompt and Allowed devices. `scripts/capture-tv-screenshot.sh <name>` captures the connected Fire TV's screen into that folder in the right format.

`appstore/icon-512.png` and `appstore/icon-114.png` are the tablet listing icons the console requires (PNG with transparency), rendered from `public/sender/icons/icon.svg`. The tablet screenshots field accepts 1920×1080, so it reuses `fire-tv/screenshots/`.
