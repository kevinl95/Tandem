# Friction log

Problems we hit while building Tandem Screen Share: the Vega Fire TV app, the Android sender, the AWS backend and the Amazon Appstore submission. Each entry gives the task, what we did, what we expected and what happened, how bad it was, how we got around it, and what would fix it.

**Severity**

- **High:** a core feature didn't work until we found a significant workaround.
- **Medium:** cost real debugging time, or needed a workaround in our code.
- **Low:** confusing or slow, but quick to get past.

| # | Area | Issue | Severity |
|---|---|---|---|
| 1 | Vega SDK | [The Virtual Device can't run WebView apps](#1-the-vega-virtual-device-cant-run-webview-apps) | High |
| 2 | Vega WebView | [Web platform support isn't documented](#2-the-webviews-web-platform-support-isnt-documented) | Medium |
| 3 | Vega WebView | [ES modules don't load from package assets](#3-es-modules-dont-load-from-package-assets) | Medium |
| 4 | Vega WebView | [Back never reaches the page](#4-back-never-reaches-the-page) | Medium |
| 5 | Vega WebView | [The page keeps running when the app leaves the screen](#5-the-page-keeps-running-when-the-app-leaves-the-screen) | Medium |
| 6 | Vega SDK | [Release builds include packages no Fire TV runs](#6-release-builds-include-packages-no-fire-tv-runs) | Low |
| 7 | Vega SDK | [Kepler and Vega names are mixed](#7-kepler-and-vega-names-are-mixed) | Low |
| 8 | Amazon Appstore | [The privacy questions assume user accounts](#8-the-privacy-questions-assume-user-accounts) | Low |
| 9 | Android WebRTC | [Newer WebRTC releases stopped delivering audio buffers](#9-newer-webrtc-releases-stopped-delivering-audio-buffers) | High |
| 10 | Fire tablets | [A 2016 Fire tablet's hardware encoder sends corrupt video](#10-a-2016-fire-tablets-hardware-encoder-sends-corrupt-video) | High |
| 11 | API Gateway | [Callbacks through a custom domain are denied](#11-callbacks-through-a-custom-domain-are-denied) | Medium |
| 12 | API Gateway + Lambda | [Messages from one connection aren't processed in order](#12-messages-from-one-connection-arent-processed-in-order) | Medium |
| 13 | CloudFront + ACM | [The certificate must be in us-east-1](#13-the-cloudfront-certificate-must-be-in-us-east-1) | Low |
| 14 | AWS CLI | [A negated JMESPath filter silently matches nothing](#14-a-negated-jmespath-filter-silently-matches-nothing) | Low |

## Vega (Fire TV)

### 1. The Vega Virtual Device can't run WebView apps

- **Task:** test the TV receiver before getting a Fire TV Stick.
- **Steps:**
  1. Generated the app with `vega project generate --template vegaWebview`.
  2. Built the Virtual Device package.
  3. Tried to run it in the Vega Virtual Device.
- **Expected:** the template's own app type runs in the SDK's simulator.
- **Actual:** the Virtual Device lacks the WebView 4 module, so the app can't run there.
- **Severity:** High. Nothing could be tested until we had hardware.
- **Workaround:** all testing on a physical Fire TV Stick, with `vega run-app` and `vega device start-log-stream`.
- **Suggestion:** include the WebView module in the Virtual Device. Until then, say on the `vegaWebview` template and the Virtual Device pages that WebView apps need real hardware.
- **More:** [vega.md](vega.md)

### 2. The WebView's web platform support isn't documented

- **Task:** find out whether the Vega WebView can receive a WebRTC screen share before building on it.
- **Steps:** searched the Vega docs for the WebView's Chromium version, WebRTC support, video codecs and ICE behavior.
- **Expected:** a capability list for the WebView, like the one Android publishes for its WebView.
- **Actual:** the docs cover installing the SDK, the Virtual Device, React Native and deployment, but not which web APIs or codecs the WebView supports.
- **Severity:** Medium. The whole design depended on an unknown.
- **Workaround:** we wrote a diagnostics page that checks the WebRTC APIs, receive codecs, ICE candidates and a loopback video decode, then ran it on the Stick. It found Chromium 144 and H264. Everything passed, with one finding: the TV only offers mDNS `.local` host candidates.
- **Suggestion:** publish the Chromium version per WebView release, plus the supported web APIs (WebRTC, media codecs, Web Audio, storage) and known differences from desktop Chrome.
- **More:** [vega.md, WebRTC probe](vega.md#webrtc-probe)

### 3. ES modules don't load from package assets

- **Task:** load the receiver page, written as standard ES modules, from the app package.
- **Steps:** pointed the WebView at `file:///pkg/assets/index.html`, which loads `<script type="module">`.
- **Expected:** the modules load, as they do from any web server.
- **Actual:** Chromium treats `file://` as an opaque `null` origin and refuses module scripts, so the page doesn't run.
- **Severity:** Medium.
- **Workaround:** [scripts/build-vega-assets.mjs](../scripts/build-vega-assets.mjs) flattens the modules into one classic script at build time.
- **Suggestion:** serve package assets from a real origin, such as a custom scheme or a virtual `https://` host like Android's `WebViewAssetLoader`. Failing that, document the limit and include a bundling step in the `vegaWebview` template.
- **More:** [vega.md](vega.md)

### 4. Back never reaches the page

- **Task:** make the remote's Back button close a dialog or end a share, and exit only when there's nothing left to close. Amazon's pre-submission checks test this.
- **Steps:** listened for Back on the page (`keydown` and history).
- **Expected:** Back reaches the page, or at least moves back through its history.
- **Actual:** Vega delivers Back natively to the React Native shell. The page never sees it.
- **Severity:** Medium.
- **Workaround:** the shell handles Back with `useKeplerBackHandler` and injects a script that calls the page's `handleBack()`. The page posts a message back when the app should exit ([vega-app/src/App.tsx](../vega-app/src/App.tsx)).
- **Suggestion:** add a WebView option that forwards Back to the page as a key event, or include this pattern in the `vegaWebview` template.
- **More:** [vega.md, App shell](vega.md#app-shell)

### 5. The page keeps running when the app leaves the screen

- **Task:** stop sharing and audio when the viewer presses Home or switches apps, which the pre-submission checks also require.
- **Steps:** pressed Home during a share with sound.
- **Expected:** the page can tell the app has left the screen, through a web-standard signal such as `visibilitychange`.
- **Actual:** the `vegaWebview` template doesn't handle this, and the docs don't say whether the WebView fires Page Visibility events. The share kept running until we handled it in the shell.
- **Severity:** Medium.
- **Workaround:** the shell listens with `useKeplerAppStateManager` and injects `onBackground()` or `onForeground()`. The page ends the share and disconnects, and reconnects when the app returns.
- **Suggestion:** fire Page Visibility events in the WebView, and document what it does on background and foreground.
- **More:** [vega.md, App shell](vega.md#app-shell)

### 6. Release builds include packages no Fire TV runs

- **Task:** upload the release package to the Appstore.
- **Steps:** ran the release build, which produced armv7, aarch64 and x86_64 `.vpkg` files.
- **Expected:** it's clear which packages to upload.
- **Actual:** aarch64 and x86_64 are only for the Virtual Device. The console matched the aarch64 package to 0 devices, without saying why.
- **Severity:** Low.
- **Workaround:** the release script builds and uploads armv7 only (`--target armv7`).
- **Suggestion:** have release builds target device architectures by default. When a package matches no devices, have the console say it's a simulator build.
- **More:** [vega.md, Releases](vega.md#releases)

### 7. Kepler and Vega names are mixed

- **Task:** find the shell APIs for Back and app state.
- **Steps:** searched the docs for Vega APIs.
- **Expected:** one product name throughout.
- **Actual:** the docs say Vega, but the packages and hooks still say Kepler (`@amazon-devices/react-native-kepler`, `useKeplerBackHandler`, `useKeplerAppStateManager`). Searches for one name miss the other.
- **Severity:** Low.
- **Workaround:** searched for both names.
- **Suggestion:** publish Vega-named aliases, or mention the old name in the API docs.

## Amazon Appstore

### 8. The privacy questions assume user accounts

- **Task:** fill in the data privacy and data deletion questions for both apps.
- **Steps:** worked through the questionnaire for an app with no accounts and no stored profile data.
- **Expected:** a clear path for apps without accounts.
- **Actual:** the questions, such as the one asking for a data deletion link, assume accounts. It wasn't obvious that "No", plus only "Device or other IDs" for the TV's allowed-device list and the server's connection records, was the right answer.
- **Severity:** Low. It took several passes to get right.
- **Workaround:** answered "No" to the deletion link question and declared only device IDs, for app functionality and fraud prevention and security, not transferred. The [privacy policy](https://tandemscreen.com/privacy.html) gives the retention times.
- **Suggestion:** a "this app has no user accounts" branch, with worked examples for apps that only handle IP addresses and device IDs.

## Android sender

### 9. Newer WebRTC releases stopped delivering audio buffers

- **Task:** send Android media playback audio (Android 10+) alongside the screen.
- **Steps:**
  1. Built the audio module with `JavaAudioDeviceModule.setAudioRecordDataCallback`.
  2. Overwrote each recorded buffer with audio from `AudioPlaybackCapture`.
  3. Shared to the TV.
- **Expected:** the callback fires for every 10 ms buffer, so playback audio replaces the microphone.
- **Actual:** in `stream-webrtc-android` releases after 1.1.3, the callback never fires, so no playback audio is sent.
- **Severity:** High. Audio was a headline feature.
- **Workaround:** pinned 1.1.3. The cost is that its arm64 library isn't aligned for 16 KB memory pages: Android 17 shows a warning on debug builds, and the app may not load on phones that use 16 KB pages. Fire tablets are unaffected.
- **Suggestion:** restore the callback, or add a supported custom audio source API to the library. Publish 16 KB-aligned builds of the version that has it.
- **More:** [android.md, Audio](android.md#audio)

### 10. A 2016 Fire tablet's hardware encoder sends corrupt video

- **Task:** share the screen from a 2016 Fire tablet (Fire OS 5, Android 5.1), one of the devices Tandem exists for.
- **Steps:** shared with the default WebRTC encoder, which picks the hardware encoder.
- **Expected:** a clean picture on the TV.
- **Actual:** the stream arrived, but most frames were corrupt. The TV showed horizontal lines, decoded the occasional keyframe, and its keyframe requests (`pliCount`) kept rising.
- **Severity:** High. That class of device was unusable by default.
- **Workaround:** a compatibility mode that encodes in software (VP8) at 960 px and 24 fps. It's on by default for Android 7.1 and older and for devices under 2 GB of RAM, and a checkbox overrides it. We couldn't retest on that tablet, because its battery failed.
- **Suggestion:** for Fire OS, publish known encoder problems on older Fire tablets. For WebRTC on Android, keep a list of hardware encoders known to be bad, as Chrome does, so apps don't each have to find them.
- **More:** [android.md, Video](android.md#video)

## AWS

### 11. Callbacks through a custom domain are denied

- **Task:** move the signaling endpoint to `wss://signal.tandemscreen.com`, so the address compiled into the apps survives backend rebuilds.
- **Steps:** added an API Gateway custom domain and API mapping. The Lambda kept building its Management API endpoint from `requestContext.domainName` and `stage`, as AWS's WebSocket examples do.
- **Expected:** `post_to_connection` keeps working.
- **Actual:** with a custom domain, the request context names the custom domain, and callbacks through it were denied. No messages reached the clients.
- **Severity:** Medium. Signaling stopped completely after the domain change.
- **Workaround:** the stack passes the execute-api endpoint to the Lambda as `CALLBACK_URL` ([infra/lambda/signaling.py](../infra/lambda/signaling.py)).
- **Suggestion:** include the execute-api callback URL in the WebSocket request context, or put a warning in the custom domain docs and the WebSocket samples.
- **More:** [deployment.md, Custom domain](deployment.md#custom-domain)

### 12. Messages from one connection aren't processed in order

- **Task:** relay trickle ICE, where candidates follow the offer within milliseconds.
- **Steps:** the sender sent its offer, then its ICE candidates as they were gathered.
- **Expected:** messages on one WebSocket connection are handled in the order sent.
- **Actual:** API Gateway can run consecutive messages in concurrent Lambda invocations. Candidates were sometimes handled before the offer had bound the sender to the TV's session, and were lost, so connections failed intermittently.
- **Severity:** Medium. The failure was intermittent and hard to reproduce.
- **Workaround:** the sender holds its candidates until the TV replies `pending` or `answer`, then flushes them ([src/sender/sender.js](../src/sender/sender.js)).
- **Suggestion:** document the lack of ordering prominently for WebSocket APIs, or offer per-connection ordered delivery, as SQS FIFO does with message groups.
- **More:** [architecture.md, Connection flow](architecture.md#connection-flow)

### 13. The CloudFront certificate must be in us-east-1

- **Task:** serve the web app at `https://tandemscreen.com` from a stack in us-west-2.
- **Steps:** added an ACM certificate to the main stack and referenced it from the distribution.
- **Expected:** one stack in one region.
- **Actual:** CloudFront only accepts certificates from us-east-1, so the certificate needs a separate stack there, and the deploy has to pass its ARN across.
- **Severity:** Low.
- **Workaround:** the deploy script creates `<stack>-site-certificate` in us-east-1 first ([infra/cloudformation/site-certificate.json](../infra/cloudformation/site-certificate.json)).
- **Suggestion:** let CloudFormation create a CloudFront certificate in us-east-1 from a stack in another region.
- **More:** [deployment.md, Custom domain](deployment.md#custom-domain)

### 14. A negated JMESPath filter silently matches nothing

- **Task:** find the domain's public Route 53 hosted zone in the deploy script.
- **Steps:** `aws route53 list-hosted-zones-by-name --query "HostedZones[?Name=='tandemscreen.com.' && !Config.PrivateZone].Id"`.
- **Expected:** the public zone's ID.
- **Actual:** no output and no error. The deploy then reported zero zones, which hid the real problem: an accidental second hosted zone.
- **Severity:** Low.
- **Workaround:** ``Config.PrivateZone==`false` ``.
- **Suggestion:** warn when a filter expression can never match, or show a negated-boolean example in the CLI's `--query` docs.
- **More:** [deployment.md](deployment.md)
