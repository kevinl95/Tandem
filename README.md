# Tandem Screen Share

Tandem shows a computer, Android phone or Fire tablet screen on an Amazon Vega Fire TV over the local Wi-Fi. It's for devices that can't send Miracast, such as most laptops and Fire tablets from before 2022.

Open the Tandem app on the Fire TV, then pick the TV at [tandemscreen.com](https://tandemscreen.com) in a desktop browser, or in the Android app. The first time a device shares, someone presses Allow on the TV.

## How it works

The devices stream to each other directly with WebRTC, so video and sound stay on the local network. A small AWS backend (API Gateway WebSocket, Lambda, DynamoDB) only introduces them: it lists the TVs on the sender's network and relays connection setup messages. The TV decides which devices may share. See [docs/architecture.md](docs/architecture.md).

## Repository layout

| Path | What's there |
|---|---|
| `vega-app/` | Fire TV app: a Vega WebView shell around the receiver page ([docs/vega.md](docs/vega.md)) |
| `public/receiver/`, `src/receiver/` | Receiver page and its WebRTC and signaling code |
| `public/sender/`, `src/sender/` | Sender web app (an installable PWA) and its WebRTC and signaling code |
| `android-sender/` | Android sender app ([docs/android.md](docs/android.md)) |
| `infra/` | CloudFormation templates and the signaling Lambda ([docs/deployment.md](docs/deployment.md)) |
| `scripts/` | Deploy, build and test helpers |
| `store/` | Appstore artwork and screenshots |
| `test/` | Tests, which also run the Lambda's Python tests |

## Getting started

You need Node.js 20+, Python 3, and the AWS CLI with credentials. Building the apps also needs the Vega SDK (Fire TV) or a JDK 17+ and the Android SDK (Android).

```bash
npm test                                                   # all tests
TANDEM_CONTACT_EMAIL=you@example.com npm run deploy        # backend + web app; prints the site URL
cd vega-app && npm install && npm run build:debug          # Fire TV app
vega run-app build/armv7-debug/tandemreceiver_armv7.vpkg   # install on a connected Fire TV Stick
```

Then open the printed site URL in a desktop browser on the same Wi-Fi as the TV, and pick the TV.

## More

- [Architecture](docs/architecture.md): connection flow, security, costs
- [Deployment](docs/deployment.md): settings, custom domain, web app hosting
- [Fire TV app](docs/vega.md): builds, releases, diagnostics
- [Android app](docs/android.md): release signing, compatibility mode, audio
