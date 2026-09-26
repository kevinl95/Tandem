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

## Local validation

```bash
npm test
```