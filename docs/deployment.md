# Deployment

`npm run deploy` (`scripts/deploy-signaling.sh`) deploys one CloudFormation stack with the signaling backend and the sender web app, writes the endpoints to `tandem.config.json`, then builds and uploads the web app.

```bash
TANDEM_DOMAIN=tandemscreen.com TANDEM_CONTACT_EMAIL=support@tandemscreen.com npm run deploy
npm run smoke:signaling   # checks the deployed relay with fake TV and sender clients
```

The Vega and Android builds read `tandem.config.json`, so build them after deploying.

## Settings

| Variable | Required | Purpose |
|---|---|---|
| `TANDEM_CONTACT_EMAIL` | Yes | Contact address in the privacy policy. The deploy stops without it, so the placeholder can't be published |
| `TANDEM_DOMAIN` | No | Custom domain with a Route 53 hosted zone (see below) |
| `TANDEM_HOSTED_ZONE_ID` | No | Picks the hosted zone if the lookup is ambiguous |
| `TANDEM_ALERT_EMAIL`, `TANDEM_BUDGET_USD` | No | AWS Budgets spend alert (default $25 a month) |
| `TANDEM_THROTTLE_RATE`, `TANDEM_THROTTLE_BURST` | No | API Gateway throttle (defaults 200 and 400 messages/s) |
| `TANDEM_STACK_NAME` | No | Stack name (default `tandem-signaling`) |

## What the stack contains

`infra/cloudformation/vega-mirroring.json` provisions:

- **API Gateway WebSocket API** with `$connect`, `$disconnect`, `$default` and a mock `ping` route, auto-deployed and throttled.
- **Lambda relay** (`infra/lambda/signaling.py`, inlined into the template by `npm run sync:lambda`), with reserved concurrency and 14-day log retention.
- **DynamoDB table** of connections, discovery listings, code claims and rate-limit counters, with a TTL for records `$disconnect` missed.
- **Sender web app:** a private S3 bucket that only its CloudFront distribution can read (Origin Access Control), served over HTTPS.

## Sender web app

`scripts/build-site.mjs` copies the page and its modules, writes `config.json` with the signaling endpoint, and adds the Android APK at `downloads/tandem.apk` if one has been built (the signed release build if present, otherwise the debug build). The deploy uploads the site and invalidates the CloudFront cache.

- **Security headers:** CloudFront adds them. The Content-Security-Policy allows scripts only from the site and connections only to the site and the signaling WebSocket. `Permissions-Policy` allows screen capture and turns off camera, microphone and location.
- **PWA:** a manifest, icons and a network-first service worker, so desktop browsers can install it. Phone and tablet browsers can't capture the screen, so the page tells them so and links to the APK.
- **Privacy policy:** served at `/privacy.html`. It states retention times the template enforces: connection records 3 hours, code claims 90 days, Lambda logs 14 days, and no API Gateway or CloudFront access logs. A test checks the template against those promises.

Browsers only allow screen capture on HTTPS or `localhost`. For local development, `python3 -m http.server 8080` in the repo root serves the sender at `http://localhost:8080/public/sender/`.

## Custom domain

With `TANDEM_DOMAIN` set, signaling runs at `wss://signal.<domain>` and the web app at `https://<domain>` and `www`. The TV's pairing screen shows the domain. CloudFront only accepts certificates from us-east-1, so the deploy first creates `<stack>-site-certificate` there (`infra/cloudformation/site-certificate.json`). The signaling certificate is in the main stack, and both validate through DNS.

The signaling endpoint is compiled into the Vega and Android apps, so release them against a domain you control. You can then rebuild or move the backend without breaking installed apps. The execute-api URL keeps working for older builds.
