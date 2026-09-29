# Tandem

Tandem mirrors a screen to an Amazon Vega Fire TV over the local network. The Fire TV supports Miracast, but many devices can't send it, including Fire tablets from before 2022 and most laptops. Tandem works from any desktop browser and from an Android app:

- **Sender → WebRTC → Vega receiver**, with media flowing directly over the LAN
- **AWS signaling** (API Gateway WebSocket, Lambda, DynamoDB) only relays offers, answers and ICE candidates
- **Discovery**: senders list the TVs that share their public IP (same WiFi), with the TV's six-character code as a fallback
- **Approval on the TV**: a device's first share needs Allow on the TV; the TV remembers allowed devices

## Repository layout

- `/public/receiver` – TV receiver page (pairing code, full-screen video)
- `/public/sender` – sender web app (installable PWA), hosted on S3 + CloudFront
- `/android-sender` – Android sender app (MediaProjection + WebRTC), sideloaded as an APK
- `/public/probe` – WebRTC capability probe
- `/src/receiver`, `/src/sender` – WebRTC and signaling logic
- `/infra/lambda/signaling.py` – signaling Lambda (source of truth, with unit tests)
- `/infra/cloudformation` – deployable signaling stack (Lambda code inlined by `npm run sync:lambda`)
- `/vega-app` – Vega WebView app that hosts the receiver page
- `/test` – Node tests, which also run the Lambda's Python tests

## Flow

1. The TV app joins as `receiver` with its pairing code (kept across launches) and a display name. The server lists it under the TV's public IP.
2. A sender connects as `sender` with a stable client id and a name, and sends `discover`. It gets back the TVs on the same public IP.
3. The sender captures the screen and sends an `offer` naming the TV's code. The server binds the sender to that session and forwards the offer to the TV, along with the sender's verified name, client id and a `sameNetwork` flag.
4. If the TV hasn't allowed this client id before, it replies `pending` and asks its viewer to Allow or Decline. It only answers allowed senders.
5. The TV's `answer` and ICE go only to the sender it names (`to`). Media flows directly over the LAN.
6. When either side leaves, the other gets `peer-left`. The TV goes back to showing its code.

Session, role and sender identity always come from the server's connection records, never from message fields.

## Try it end to end

```bash
TANDEM_CONTACT_EMAIL=you@example.com npm run deploy   # deploys the stack, uploads the web app, prints its URL
npm run smoke:signaling      # checks the deployed relay with fake TV and sender clients

cd vega-app && npm run build:debug \
  && vega run-app build/armv7-debug/tandemreceiver_armv7.vpkg   # TV shows a code
```

Then open the printed `https://….cloudfront.net` URL in a desktop browser on the same WiFi. Chrome and Edge offer to install it as an app. While sharing, the page shows the selected ICE path, resolution, frame rate, codec and bitrate.

For local development, `python3 -m http.server 8080` in the repo root serves the page at `http://localhost:8080/public/sender/`. Browsers only allow screen capture on HTTPS or `localhost`, which is why other people need the hosted URL.

## Sender web app hosting

The same stack serves the sender as a static site: a private S3 bucket that only its CloudFront distribution can read (Origin Access Control), over HTTPS. `npm run deploy` builds it with `scripts/build-site.mjs`, which copies the page and its modules, writes `config.json` with the signaling endpoint, and adds the Android APK at `downloads/tandem.apk` if one has been built. It then uploads the site and invalidates the CloudFront cache. The site includes the privacy policy at `/privacy.html`, which lists `TANDEM_CONTACT_EMAIL` as the contact; the deploy stops if that variable isn't set, so the placeholder can't be published. The policy states retention times the template enforces: connection records expire after 3 hours, code claims after 90 days, Lambda logs after 14 days, and neither API Gateway nor CloudFront keeps access logs. A test checks the template against those promises.

CloudFront adds security headers. The Content-Security-Policy allows scripts only from the site and connections only to the site and the signaling WebSocket. `Permissions-Policy` allows screen capture on the page and turns off camera, microphone and location. The site is a PWA (manifest, icons and a network-first service worker), so desktop browsers can install it. Phone and tablet browsers can't capture the screen even when installed, so the page tells them so and links to the APK. At about 60 KB a visit, hosting stays within CloudFront's always-free allowance (1 TB and 10 million requests a month).

Mobile browsers can't capture the screen (`getDisplayMedia` isn't supported on Chrome for Android or iOS Safari), so phones use the Android app below.

## Android sender

`/android-sender` is a small Kotlin app. It lists TVs on the WiFi and shares the screen through a `mediaProjection` foreground service. The build bakes in the signaling endpoint from `tandem.config.json`. It needs a full JDK 17 or newer (a JRE isn't enough) and the Android SDK.

```bash
cd android-sender
JAVA_HOME=/path/to/jdk-21 ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

**Release signing.** `./gradlew assembleRelease` signs with a key kept outside the repo. `~/.gradle/gradle.properties` sets `tandem.keystore.file`, `tandem.keystore.password`, `tandem.key.alias` and `tandem.key.password`. Back up the keystore and its password together: app updates must be signed with the same key. The website serves the release APK when one is built, and the debug APK otherwise. Android won't install a build signed with a different key over an existing install, so switching between debug and release builds means uninstalling first.

The APK is available from the website, and it's being submitted to the Amazon Appstore for Fire tablets. It runs on Android 5.1 (API 22) and newer, which covers Fire tablets back to Fire OS 5. Fire OS has no Google Play, and the app doesn't need it: turn on "Apps from unknown sources" and install the APK. On devices with less than 2 GB of RAM, or ones Android marks as low-RAM, the app captures at 1280 px on the long edge and 24 fps instead of 1920 px and 30 fps, so older tablets can keep up with real-time encoding.

**Compatibility mode** encodes video in software (VP8) at 960 px and 24 fps instead of using the device's hardware encoder. On a 2016 Fire tablet (Fire OS 5), the hardware encoder produced corrupt frames that showed up on the TV as horizontal lines, and compatibility mode fixed it. It's on by default for Android 7.1 and older (Fire OS 5 and 6) and devices under 2 GB of RAM, and the checkbox in the app overrides the default. While sharing, the app shows what it's sending: capture size, codec and encoder.

If the app crashes with a Java error, the next launch shows the stack trace on screen, since old tablets often can't be debugged over USB. While a share runs, the Fire TV app logs incoming video stats (codec, size, frames decoded, keyframe requests) every 10 seconds, so `vega device start-log-stream` shows whether a sender's stream decodes cleanly.

**Audio** (Android 10+; older devices share video only): The app sends the phone's media playback, using Android playback capture. Calls, notifications and apps that opt out of capture (typically DRM streaming apps) aren't included. WebRTC's Android audio pipeline is paced by a microphone recorder, so the app needs the microphone permission and shows the mic indicator while sharing. It overwrites every recorded buffer with playback audio or silence, so microphone audio is never sent. If the permission is denied, sharing continues video-only. This relies on `stream-webrtc-android` 1.1.3; later releases no longer call the record-data callback. The trade-off is that 1.1.3's arm64 native library isn't aligned for 16 KB memory pages, so it may fail to load on newer Android 15+ phones that use them.

**VPNs:** A phone on a VPN reaches AWS from the VPN's IP, so TVs on its WiFi aren't listed (enter the code instead). An always-on VPN that blocks non-VPN traffic also blocks the direct LAN connection to the TV, and the share fails. Allow local network (LAN) access in the VPN app, or exclude Tandem from the tunnel. The app shows a hint when a VPN is active.

## Security

- **TV approval:** The TV never answers a sender its viewer hasn't allowed. The prompt offers Allow, Decline and Block. Allowed devices are remembered by client id; blocked devices are declined silently, and a declined device can't prompt again for a minute. Devices from another network get a warning, and Decline is focused by default.
- **Allowed devices** on the TV's pairing screen lists allowed and blocked devices, with Forget or Unblock for each and Forget all.
- **Code ownership:** A TV claims its code with a secret it keeps locally; the server stores only a hash and refuses any other receiver presenting that code, so nobody can pose as a TV to receive its shares. Unused codes are released after 90 days.
- **Rate limits per source IP**, over 10-minute windows: 10 offers to codes with no TV behind them (guessing), and 30 offers of any kind (prompt spam, even with fresh client ids). Past either limit, offers from that IP are refused (`rate-limited`).
- **Throttling** at the API Gateway stage caps total message rate.
- Discovery only lists TVs sharing the sender's public IP. Anyone on the same network, including a shared or carrier-grade NAT, can see those TVs, but approval still gates sharing.

## Custom domain

Set `TANDEM_DOMAIN` to a domain whose hosted zone is in Route 53:

```bash
TANDEM_DOMAIN=tandemscreen.com TANDEM_CONTACT_EMAIL=support@tandemscreen.com npm run deploy
```

Signaling then runs at `wss://signal.<domain>` and the web app at `https://<domain>` (and `www`). The TV's pairing screen shows the domain so people know where to go. CloudFront only accepts certificates from us-east-1, so the deploy first creates `<stack>-site-certificate` there (`infra/cloudformation/site-certificate.json`). The signaling certificate is created in the main stack, and both validate through DNS automatically.

Build the Vega and Android apps against the custom domain before releasing them. The signaling endpoint is compiled into both, so if it's a domain you control, you can rebuild or move the backend later without breaking installed apps. The execute-api URL keeps working for older builds.

## Costs

AWS only relays signaling, and media never touches it. There's deliberately no TURN server, because it would bill for every relayed gigabyte of video. The costs come from open connections and messages. At list prices (US regions, 2026), that's $0.25 per million connection-minutes and $1 per million messages, plus a Lambda invocation and DynamoDB access per relayed message. The design keeps both low:

- The TV disconnects after 15 minutes with nobody sharing and reconnects when OK is pressed. The Android app disconnects when it's in the background and not sharing.
- Keepalive `ping`s go every 9 minutes, just under API Gateway's 10-minute idle timeout. API Gateway answers them itself through a mock integration, with no Lambda or DynamoDB.
- Senders refresh discovery every 15 seconds, and only while visible.
- Failed TV reconnects back off exponentially, up to one minute apart.

**Worst-case ceilings:** The stage throttle (default 200 messages/s, about $520 a month even if saturated), the Lambda's reserved concurrency (default 50) and an optional AWS Budgets alert. For the alert, also set `TANDEM_ALERT_EMAIL=you@example.com` when deploying; `TANDEM_BUDGET_USD` sets the monthly amount (default 25). `TANDEM_THROTTLE_RATE` and `TANDEM_THROTTLE_BURST` override the throttle (defaults 200 and 400).

## AWS signaling stack

The CloudFormation template provisions:

- API Gateway WebSocket API (`$connect`, `$disconnect`, `$default`, and a mock `ping` route), auto-deployed and throttled
- Lambda relay (`infra/lambda/signaling.py`)
- DynamoDB table of connections, discovery listings, code claims and rate-limit counters, with a TTL for records `$disconnect` missed

## Vega app

`/vega-app` is a Vega WebView app (generated from the SDK's `vegaWebview` template) that hosts the receiver page from `file:///pkg/assets`. Chromium blocks ES module scripts on `file://`, so `scripts/build-vega-assets.mjs` flattens the receiver modules into one classic script. It inlines the signaling endpoint (from `TANDEM_SIGNALING_URL` or `tandem.config.json`) and copies everything, plus the WebRTC probe, into `vega-app/assets`. The Vega build scripts run this step automatically.

```bash
cd vega-app
npm install
npm run build:debug        # syncs web assets, then builds .vpkg files under build/
vega run-app build/armv7-debug/tandemreceiver_armv7.vpkg   # Fire TV Stick
```

The Vega Virtual Device can't run this app because it lacks the WebView 4 module. Use a physical Fire TV Stick.

`npm run build:release` builds the Appstore package: armv7, which is what Vega Fire TV Sticks run. The other architectures are only for the Vega Virtual Device (x86_64 on Intel computers, aarch64 on Apple Silicon Macs), so don't upload them; the Appstore matches no Fire TV devices to them. Each release needs a higher version and build number (1.0.0 is build 1); set both in the `build:release` script in `vega-app/package.json`, and keep the version in `manifest.toml` matching.

### WebRTC probe

**Run WebRTC diagnostics** on the receiver page checks the WebRTC APIs, the video receive codecs, ICE host candidates (including mDNS obfuscation), and a loopback video decode. It shows the results on screen and logs them with the `[tandem]` prefix:

```bash
vega device start-log-stream   # look for "[tandem] probe-report"
```

On a Fire TV Stick (WebView Chromium 144), everything passes except one warning, because the TV's host candidates are mDNS `.local` names only.

## Local validation

```bash
npm test
```
