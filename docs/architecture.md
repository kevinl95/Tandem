# Architecture

Tandem has three clients and one small backend:

- **TV receiver:** a Vega app whose WebView runs `public/receiver` and `src/receiver`.
- **Senders:** the web app (`public/sender`, `src/sender`) and the Android app (`android-sender`).
- **Signaling:** an API Gateway WebSocket API with a Lambda (`infra/lambda/signaling.py`) and a DynamoDB table. It only relays connection setup messages. Screen video and sound go directly between the devices over WebRTC, on the local network.

## Connection flow

1. The TV app joins as `receiver` with its pairing code (kept across launches) and a display name. The server lists it under the TV's public IP.
2. A sender connects as `sender` with a stable client id and a name, and sends `discover`. It gets back the TVs on the same public IP.
3. The sender captures the screen and sends an `offer` naming the TV's code. The server binds the sender to that session and forwards the offer to the TV, along with the sender's verified name, client id and a `sameNetwork` flag.
4. If the TV hasn't allowed this client id before, it replies `pending` and asks its viewer to Allow or Decline. It only answers allowed senders.
5. The TV's `answer` and ICE candidates go only to the sender it names (`to`). Media then flows directly over the LAN.
6. When either side leaves, the other gets `peer-left`, and the TV goes back to showing its code.

Session, role and sender identity always come from the server's connection records, never from message fields.

## Security

- **TV approval:** the TV never answers a sender its viewer hasn't allowed. The prompt offers Allow, Decline and Block. Allowed devices are remembered by client id; blocked devices are declined silently, and a declined device can't prompt again for a minute. Devices from another network get a warning, and Decline is focused by default.
- **Allowed devices:** the TV's pairing screen lists allowed and blocked devices, with Forget or Unblock for each, and Forget all.
- **Code ownership:** a TV claims its code with a secret it keeps locally. The server stores only a hash and refuses any other receiver presenting that code, so nobody can pose as a TV to receive its shares. Unused codes are released after 90 days.
- **Rate limits per source IP,** over 10-minute windows: 10 offers to codes with no TV behind them (guessing), and 30 offers of any kind (prompt spam, even with fresh client ids). Past either limit, offers from that IP are refused (`rate-limited`).
- **Throttling** at the API Gateway stage caps the total message rate.
- **Discovery** only lists TVs sharing the sender's public IP. Anyone on the same network, including a shared or carrier-grade NAT, can see those TVs, but approval still gates sharing.

## Costs

AWS only relays signaling. There's deliberately no TURN server, because it would bill for every relayed gigabyte of video. The costs come from open connections and messages: at list prices (US regions, 2026), $0.25 per million connection-minutes and $1 per million messages, plus a Lambda invocation and DynamoDB access per relayed message. The design keeps both low:

- The TV disconnects after 15 minutes with nobody sharing and reconnects when OK is pressed. The Android app disconnects when it's in the background and not sharing.
- Keepalive `ping`s go every 9 minutes, just under API Gateway's 10-minute idle timeout. API Gateway answers them itself through a mock integration, with no Lambda or DynamoDB.
- Senders refresh discovery every 15 seconds, and only while visible.
- Failed TV reconnects back off exponentially, up to one minute apart.

The worst case is bounded by the stage throttle (default 200 messages/s, about $520 a month even if saturated), the Lambda's reserved concurrency (default 50) and an optional AWS Budgets alert. See [deployment.md](deployment.md) for the settings.
