#!/usr/bin/env bash
# Deploys the signaling stack and writes its WebSocket URL to tandem.config.json,
# which the Vega asset build and the sender page read.
set -euo pipefail

cd "$(dirname "$0")/.."
stack_name="${TANDEM_STACK_NAME:-tandem-signaling}"

node scripts/sync-lambda.mjs
# The throttle bounds the worst-case bill, so always pass it: `deploy` otherwise
# keeps an existing stack's previous values and ignores new template defaults.
overrides=(
  "ThrottlingRateLimit=${TANDEM_THROTTLE_RATE:-200}"
  "ThrottlingBurstLimit=${TANDEM_THROTTLE_BURST:-400}"
)
# Set TANDEM_ALERT_EMAIL to get AWS Budgets spend alerts (TANDEM_BUDGET_USD, default 25).
if [[ -n "${TANDEM_ALERT_EMAIL:-}" ]]; then
  overrides+=("AlertEmail=$TANDEM_ALERT_EMAIL" "MonthlyBudgetUsd=${TANDEM_BUDGET_USD:-25}")
fi

aws cloudformation deploy \
  --template-file infra/cloudformation/vega-mirroring.json \
  --stack-name "$stack_name" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "${overrides[@]}"

signaling_url="$(aws cloudformation describe-stacks \
  --stack-name "$stack_name" \
  --query "Stacks[0].Outputs[?OutputKey=='SignalingWebSocketUrl'].OutputValue" \
  --output text)"

printf '{\n  "signalingEndpoint": "%s"\n}\n' "$signaling_url" > tandem.config.json
echo "Signaling endpoint: $signaling_url (saved to tandem.config.json)"
