#!/usr/bin/env bash
# Deploys the Tandem stack (signaling + sender web app), writes the endpoints to
# tandem.config.json (read by the Vega and Android builds), then builds and
# uploads the web app to S3 and refreshes CloudFront.
set -euo pipefail

cd "$(dirname "$0")/.."
stack_name="${TANDEM_STACK_NAME:-tandem-signaling}"

# The web app's privacy policy lists this address; check before deploying.
if [[ -z "${TANDEM_CONTACT_EMAIL:-}" ]]; then
  echo "Set TANDEM_CONTACT_EMAIL to the support email for the privacy policy." >&2
  exit 1
fi

node scripts/sync-lambda.mjs
# The throttle bounds the worst-case bill, so always pass it: `deploy` otherwise
# keeps an existing stack's previous values and ignores new template defaults.
overrides=(
  "ThrottlingRateLimit=${TANDEM_THROTTLE_RATE:-200}"
  "ThrottlingBurstLimit=${TANDEM_THROTTLE_BURST:-400}"
)
# Optional custom domain, e.g. TANDEM_DOMAIN=tandemscreen.com, registered in (or
# delegated to) Route 53. Signaling moves to wss://signal.<domain> and the web
# app to https://<domain>. CloudFront only accepts us-east-1 certificates, so
# that certificate gets its own stack there; deploying it waits for DNS
# validation.
if [[ -n "${TANDEM_DOMAIN:-}" ]]; then
  hosted_zone_id="${TANDEM_HOSTED_ZONE_ID:-}"
  if [[ -z "$hosted_zone_id" ]]; then
    # Only a zone the domain is delegated to answers queries, and duplicate
    # zones with the same name are easy to create by accident, so insist on one.
    zones="$(aws route53 list-hosted-zones-by-name \
      --dns-name "$TANDEM_DOMAIN" \
      --query "HostedZones[?Name=='$TANDEM_DOMAIN.' && Config.PrivateZone==\`false\`].Id" \
      --output text)"
    zone_count="$(wc -w <<< "$zones")"
    if [[ "$zone_count" -ne 1 ]]; then
      echo "Found $zone_count public hosted zones for $TANDEM_DOMAIN ($zones)." >&2
      echo "Delete the extra zone(s), or set TANDEM_HOSTED_ZONE_ID to the one the domain's nameservers point to." >&2
      exit 1
    fi
    hosted_zone_id="$zones"
  fi
  hosted_zone_id="${hosted_zone_id#/hostedzone/}"

  aws cloudformation deploy \
    --region us-east-1 \
    --template-file infra/cloudformation/site-certificate.json \
    --stack-name "$stack_name-site-certificate" \
    --no-fail-on-empty-changeset \
    --parameter-overrides "DomainName=$TANDEM_DOMAIN" "HostedZoneId=$hosted_zone_id"
  site_certificate_arn="$(aws cloudformation describe-stacks \
    --region us-east-1 \
    --stack-name "$stack_name-site-certificate" \
    --query "Stacks[0].Outputs[?OutputKey=='SiteCertificateArn'].OutputValue" \
    --output text)"

  overrides+=(
    "DomainName=$TANDEM_DOMAIN"
    "HostedZoneId=$hosted_zone_id"
    "SiteCertificateArn=$site_certificate_arn"
  )
fi

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

output() {
  aws cloudformation describe-stacks \
    --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}
signaling_url="$(output SignalingWebSocketUrl)"
site_url="$(output SiteUrl)"
site_bucket="$(output SiteBucketName)"
distribution_id="$(output SiteDistributionId)"

printf '{\n  "signalingEndpoint": "%s",\n  "siteUrl": "%s"\n}\n' "$signaling_url" "$site_url" > tandem.config.json

node scripts/build-site.mjs
# Files keep fixed names, so browsers revalidate everything; the APK and the
# manifest need explicit content types.
aws s3 sync dist/site "s3://$site_bucket" --delete --only-show-errors \
  --cache-control "no-cache" \
  --exclude "*.webmanifest" --exclude "*.apk"
aws s3 cp dist/site/manifest.webmanifest "s3://$site_bucket/manifest.webmanifest" --only-show-errors \
  --cache-control "no-cache" --content-type "application/manifest+json"
if [[ -f dist/site/downloads/tandem.apk ]]; then
  aws s3 cp dist/site/downloads/tandem.apk "s3://$site_bucket/downloads/tandem.apk" --only-show-errors \
    --cache-control "no-cache" --content-type "application/vnd.android.package-archive"
fi
aws cloudfront create-invalidation --distribution-id "$distribution_id" --paths "/*" \
  --query "Invalidation.Id" --output text > /dev/null

echo "Signaling endpoint: $signaling_url"
echo "Sender web app:     $site_url"
