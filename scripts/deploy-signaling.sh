#!/usr/bin/env bash
# Deploys the signaling stack and writes its WebSocket URL to tandem.config.json,
# which the Vega asset build and the sender page read.
set -euo pipefail

cd "$(dirname "$0")/.."
stack_name="${TANDEM_STACK_NAME:-tandem-signaling}"

node scripts/sync-lambda.mjs
aws cloudformation deploy \
  --template-file infra/cloudformation/vega-mirroring.json \
  --stack-name "$stack_name" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset

signaling_url="$(aws cloudformation describe-stacks \
  --stack-name "$stack_name" \
  --query "Stacks[0].Outputs[?OutputKey=='SignalingWebSocketUrl'].OutputValue" \
  --output text)"

printf '{\n  "signalingEndpoint": "%s"\n}\n' "$signaling_url" > tandem.config.json
echo "Signaling endpoint: $signaling_url (saved to tandem.config.json)"
