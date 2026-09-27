# Tandem

Tandem mirrors a screen to an Amazon Vega Fire TV over the local network:

- **Sender → WebRTC → Vega receiver**, with media flowing directly over the LAN
- **AWS signaling** (API Gateway WebSocket, Lambda, DynamoDB) only relays offers, answers and ICE candidates
- **Discovery**: senders list the TVs that share their public IP (same WiFi), with the TV's six-character code as a fallback
- **Approval on the TV**: a device's first share needs Allow on the TV; the TV remembers allowed devices

## Repository layout

- `/public/receiver` – TV receiver page (pairing code, full-screen video)
- `/public/sender` – desktop browser sender page
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
3. The sender captures the screen and sends an `offer` naming the TV's code. The server binds the sender to that session and forwards the offer to the TV. The server adds the sender's verified name, client id and a `sameNetwork` flag.
4. If the TV hasn't allowed this client id before, it replies `pending` and asks its viewer to Allow or Decline. It only answers allowed senders.
5. The TV's `answer` and ICE go only to the sender it names (`to`). Media flows directly over the LAN.
6. When either side leaves, the other gets `peer-left`. The TV goes back to showing its code.

Session, role and sender identity always come from the server's connection records, never from message fields.

## Try it end to end

```bash
npm run deploy:signaling     # deploys the stack, writes tandem.config.json
npm run smoke:signaling      # checks the deployed relay with two fake clients

cd vega-app && npm run build:debug \
  && vega run-app build/armv7-debug/tandemreceiver_armv7.vpkg   # TV shows a code

cd .. && python3 -m http.server 8080
# In desktop Chrome on the same WiFi: http://localhost:8080/public/sender/
```

The sender page reads the endpoint from `tandem.config.json` and shows the selected ICE path, resolution, frame rate, codec and bitrate while sharing.

Mobile browsers can't capture the screen (`getDisplayMedia` isn't supported on Chrome for Android or iOS Safari), so phones use the Android app below.

## Android sender

`/android-sender` is a small Kotlin app. It lists TVs on the WiFi and shares the screen through a `mediaProjection` foreground service. The build bakes in the signaling endpoint from `tandem.config.json`. It needs a full JDK 17 or newer (a JRE isn't enough) and the Android SDK.

```bash
cd android-sender
JAVA_HOME=/path/to/jdk-21 ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The APK is sideloaded; there's no store listing.

**Audio** (Android 10+): the app sends the phone's media playback, using Android playback capture. Calls, notifications and apps that opt out of capture (typically DRM streaming apps) aren't included. WebRTC's Android audio pipeline is paced by a microphone recorder, so the app needs the microphone permission and shows the mic indicator while sharing. It overwrites every recorded buffer with playback audio or silence, so microphone audio is never sent. If the permission is denied, sharing continues video-only. This relies on `stream-webrtc-android` 1.1.3; later releases no longer call the record-data callback.

**VPNs:** a phone on a VPN reaches AWS from the VPN's IP, so TVs on its WiFi aren't listed (enter the code instead). An always-on VPN that blocks non-VPN traffic also blocks the direct LAN connection to the TV, and the share fails. Allow local network (LAN) access in the VPN app, or exclude Tandem from the tunnel. The app shows a hint when a VPN is active.

## Security

- **TV approval** is enforced by the TV, which never answers a sender its viewer hasn't allowed. Allowed devices are remembered by client id. Devices from another network get a warning, and Decline is focused by default.
- **Code ownership:** a TV claims its code with a secret it keeps locally; the server stores only a hash and refuses any other receiver presenting that code, so nobody can pose as a TV to receive its shares. Unused codes are released after 90 days.
- **Code guessing:** offers to codes with no TV behind them count against the source IP. After 10 in 10 minutes, further offers from that IP are refused (`rate-limited`).
- **Throttling** at the API Gateway stage caps total message rate.
- Discovery only lists TVs sharing the sender's public IP. Anyone on the same network, including a shared or carrier-grade NAT, can see those TVs, but approval still gates sharing.

## Costs

AWS only relays signaling; media never touches it, so there is no TURN server (it would bill every relayed gigabyte of video). What costs money is open connections and messages. At list prices (US regions, 2026), that's $0.25 per million connection-minutes and $1 per million messages, plus a Lambda invocation and DynamoDB access per relayed message. The design keeps both low:

- The TV disconnects after 15 minutes with nobody sharing and reconnects when OK is pressed. The Android app disconnects when it's in the background and not sharing.
- Keepalive `ping`s go every 9 minutes, and API Gateway answers them itself through a mock integration, with no Lambda or DynamoDB.
- Senders refresh discovery every 15 seconds, and only while visible.
- Failed TV reconnects back off exponentially, up to one minute apart.

**Worst-case ceilings:** the stage throttle (default 200 messages/s, about $520 a month even if saturated), the Lambda's reserved concurrency (default 50) and an optional AWS Budgets alert. For the alert, deploy with `TANDEM_ALERT_EMAIL=you@example.com npm run deploy:signaling`; `TANDEM_BUDGET_USD` sets the monthly amount (default 25). `TANDEM_THROTTLE_RATE` and `TANDEM_THROTTLE_BURST` override the throttle (defaults 200 and 400).

## AWS signaling stack

The CloudFormation template provisions:

- API Gateway WebSocket API (`$connect`, `$disconnect`, `$default`, and a mock `ping` route), auto-deployed and throttled
- Lambda relay (`infra/lambda/signaling.py`)
- DynamoDB table of connections, discovery listings and rate-limit counters, with a TTL for records `$disconnect` missed

Clients send a `ping` every 9 minutes, because API Gateway drops WebSockets that are idle for 10 minutes. The receiver reconnects after drops.

## Vega app

`/vega-app` is a Vega WebView app (generated from the SDK's `vegaWebview` template) that hosts the receiver page from `file:///pkg/assets`. Chromium blocks ES module scripts on `file://`, so `scripts/build-vega-assets.mjs` flattens the receiver modules into one classic script. It inlines the signaling endpoint (from `TANDEM_SIGNALING_URL` or `tandem.config.json`) and copies everything, plus the WebRTC probe, into `vega-app/assets`. The Vega build scripts run this step automatically.

```bash
cd vega-app
npm install
npm run build:debug        # syncs web assets, then builds .vpkg files under build/
vega run-app build/armv7-debug/tandemreceiver_armv7.vpkg   # Fire TV Stick
```

The Vega Virtual Device can't run this app because it lacks the WebView 4 module. Use a physical Fire TV Stick.

### WebRTC probe

**Run WebRTC diagnostics** on the receiver page checks the WebRTC APIs, the video receive codecs, ICE host candidates (including mDNS obfuscation), and a loopback video decode. It shows the results on screen and logs them with the `[tandem]` prefix:

```bash
vega device start-log-stream   # look for "[tandem] probe-report"
```

On a Fire TV Stick (WebView Chromium 144), everything passes. The one warning: the TV's host candidates are mDNS `.local` names only.

## Local validation

```bash
npm test
```
