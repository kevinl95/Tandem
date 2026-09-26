# Tandem

Tandem mirrors a screen to an Amazon Vega Fire TV over the local network:

- **Sender → WebRTC → Vega receiver**, with media flowing directly over the LAN
- **AWS signaling** (API Gateway WebSocket, Lambda, DynamoDB) only relays offers, answers and ICE candidates
- **Pairing by code**: the TV shows a six-character code that the sender enters

## Repository layout

- `/public/receiver` – TV receiver page (pairing code, full-screen video)
- `/public/sender` – desktop browser sender page
- `/public/probe` – WebRTC capability probe
- `/src/receiver`, `/src/sender` – WebRTC and signaling logic
- `/infra/lambda/signaling.py` – signaling Lambda (source of truth, with unit tests)
- `/infra/cloudformation` – deployable signaling stack (Lambda code inlined by `npm run sync:lambda`)
- `/vega-app` – Vega WebView app that hosts the receiver page
- `/test` – Node tests, which also run the Lambda's Python tests

## Flow

1. The TV app shows a pairing code (kept across launches) and joins that session as `receiver`.
2. The sender enters the code, captures the screen, joins as `sender` and sends an offer.
3. The Lambda relays messages only between the sender and receiver in the same session. Session and role come from the connection record, never from the message.
4. The TV answers, both sides trickle ICE candidates, and video flows directly over the LAN.
5. When either side leaves, the other gets `peer-left`. The TV goes back to showing its code.

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

Mobile browsers can't capture the screen, so phones will need a native sender app.

## AWS signaling stack

The CloudFormation template provisions:

- API Gateway WebSocket API (`$connect`, `$disconnect`, `$default`), auto-deployed and throttled
- Lambda relay (`infra/lambda/signaling.py`)
- DynamoDB table of connections, with a TTL for records `$disconnect` missed

Clients send a `ping` every 5 minutes, because API Gateway drops WebSockets that are idle for 10 minutes. The receiver reconnects after drops.

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
