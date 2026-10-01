# Vega (Fire TV) app

`vega-app` is a Vega WebView app, generated from the SDK's `vegaWebview` template, that hosts the receiver page from `file:///pkg/assets`. Chromium blocks ES module scripts on `file://`, so `scripts/build-vega-assets.mjs` flattens the receiver modules into one classic script and inlines the signaling endpoint (from `TANDEM_SIGNALING_URL` or `tandem.config.json`). The Vega build scripts run this step automatically.

```bash
cd vega-app
npm install
npm run build:debug   # builds .vpkg files under build/
vega run-app build/armv7-debug/tandemreceiver_armv7.vpkg
```

The Vega Virtual Device can't run this app, because it lacks the WebView 4 module. Use a physical Fire TV Stick.

## Releases

`npm run build:release` builds the Appstore package for armv7, which is what Vega Fire TV Sticks run. The release build leaves out the WebRTC diagnostics page. The other architectures are only for the Vega Virtual Device (x86_64 on Intel computers, aarch64 on Apple Silicon Macs), so don't upload them: the Appstore matches no Fire TV devices to them.

Each release needs a higher version and build number (1.0.0 is build 1). Set both in the `build:release` script in `vega-app/package.json`, and keep the version in `manifest.toml` matching.

## App shell

`src/App.tsx` owns two things the page can't do by itself:

- **Back:** Vega delivers it natively, not to the page. The shell passes it to the page, which closes a dialog, ends a share, or asks the shell to exit.
- **Background and foreground:** when the app leaves the screen, the page ends any share and disconnects; it reconnects when the app returns.

## Images and screenshots

- **Package icon and splash screen:** `vega-app/assets/image/app_icon.png` and `assets/raw/SplashScreenImages.zip` are generated from `store/` by `scripts/build-vega-images.sh` (ImageMagick 7). `store/README.md` lists the Appstore assets.
- **Screenshots:** `scripts/capture-tv-screenshot.sh <name>` captures the connected Fire TV's screen as a 1920×1080 listing screenshot.

## WebRTC probe

Debug builds include **Run WebRTC diagnostics** on the receiver page. It checks the WebRTC APIs, video receive codecs, ICE host candidates (including mDNS obfuscation) and a loopback video decode, and logs the results with the `[tandem]` prefix (`vega device start-log-stream`). On a Fire TV Stick (WebView Chromium 144), everything passes except one warning: the TV's host candidates are mDNS `.local` names only.
