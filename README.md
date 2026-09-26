# Tandem

Tandem is a minimal starter for an Amazon Vega / Fire TV screen-mirroring receiver that keeps media on the local network:

- **Phone → WebRTC → Vega receiver**
- **Host ICE candidates are preferred** for the primary direct path
- **Optional STUN** can be injected for broader network compatibility
- **Optional AWS signaling** is provided for device discovery and session establishment
- **AWS infrastructure is deployable with CloudFormation**

## Repository layout

- `/public/receiver` – static Vega receiver UI
- `/src/receiver` – WebRTC receiver runtime modules
- `/infra/cloudformation` – deployable AWS signaling stack
- `/test` – focused validation for the receiver configuration and infra template

## Receiver flow

1. Load the receiver UI on the Vega device.
2. Create or enter a session ID.
3. Paste an offer manually **or** connect the page to the optional AWS WebSocket signaling endpoint.
4. The receiver answers the WebRTC offer and prefers host ICE candidates before relay-style fallbacks.

## AWS signaling stack

The CloudFormation template provisions:

- API Gateway WebSocket API for signaling
- Lambda handler for session coordination
- DynamoDB table for connection/session lookups

The stack only coordinates offers, answers, and ICE candidates. Screen media is not routed through AWS.

## Vega app

`/vega-app` is a Vega WebView app (generated from the SDK's `vegaWebview` template) that hosts the receiver page from `file:///pkg/assets`. Chromium blocks ES module scripts on `file://`, so `scripts/build-vega-assets.mjs` flattens the receiver modules into one classic script and copies it, plus the WebRTC probe, into `vega-app/assets`. The Vega build scripts run this step automatically.

```bash
cd vega-app
npm install
npm run build:debug        # syncs web assets, then builds .vpkg files under build/
vega run-app build/armv7-debug/tandemreceiver_armv7.vpkg   # Fire TV Stick
```

The Vega Virtual Device can't run this app because it lacks the WebView 4 module. Use a physical Fire TV Stick.

### WebRTC probe

Vega's docs don't say whether the WebView (Chromium 144 as of SDK 0.24) ships WebRTC. Before building further, open **Run WebRTC diagnostics** on the receiver page. It checks the WebRTC APIs, the video receive codecs, ICE host candidates (including mDNS obfuscation), and a loopback video decode. It shows the results on screen and logs them with the `[tandem]` prefix:

```bash
vega device start-log-stream   # look for "[tandem] probe-report"
```

The same probe runs in a desktop browser at `/public/probe/` for comparison.

## Local validation

```bash
npm test
```