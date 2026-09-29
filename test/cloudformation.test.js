import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lambdaSourcePath, templatePath } from "../scripts/sync-lambda.mjs";

const template = JSON.parse(readFileSync(templatePath, "utf8"));
const inlineLambda = template.Resources.SignalingFunction.Properties.Code.ZipFile;

test("cloudformation template provisions signaling coordination resources", () => {
  assert.equal(template.Resources.SignalingApi.Type, "AWS::ApiGatewayV2::Api");
  assert.equal(template.Resources.SignalingFunction.Type, "AWS::Lambda::Function");
  assert.equal(template.Resources.SessionsTable.Type, "AWS::DynamoDB::Table");
});

test("cloudformation inline Lambda matches infra/lambda/signaling.py", () => {
  assert.equal(
    inlineLambda,
    readFileSync(lambdaSourcePath, "utf8"),
    "run `npm run sync:lambda` after editing infra/lambda/signaling.py",
  );
});

test("cloudformation inline handler compiles as valid Python", () => {
  const result = spawnSync(
    "python3",
    ["-c", "import sys; compile(sys.stdin.read(), '<inline>', 'exec')"],
    { input: inlineLambda, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
});

test("signaling Lambda unit tests pass", () => {
  const result = spawnSync("python3", ["-m", "unittest", "-q"], {
    cwd: fileURLToPath(new URL("../infra/lambda", import.meta.url)),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("cloudformation template expires stale connection records", () => {
  assert.deepEqual(template.Resources.SessionsTable.Properties.TimeToLiveSpecification, {
    AttributeName: "expiresAt",
    Enabled: true,
  });
});

test("cloudformation stage auto-deploys route changes and is throttled", () => {
  const stage = template.Resources.Stage.Properties;

  assert.equal(stage.AutoDeploy, true);
  assert.ok(stage.DefaultRouteSettings.ThrottlingRateLimit);
  assert.ok(stage.DefaultRouteSettings.ThrottlingBurstLimit);
});

test("cloudformation template exports the websocket endpoint, on the custom domain when set", () => {
  const [condition, withDomain, withoutDomain] = template.Outputs.SignalingWebSocketUrl.Value["Fn::If"];

  assert.equal(condition, "HasDomain");
  assert.equal(withDomain["Fn::Sub"], "wss://signal.${DomainName}");
  assert.match(withoutDomain["Fn::Sub"], /^wss:\/\/\$\{SignalingApi\}\.execute-api/);
});

test("the custom domain is optional and wires signaling, the web app and DNS together", () => {
  const resources = template.Resources;
  const domainResources = Object.entries(resources).filter(([, resource]) => resource.Condition);

  assert.equal(template.Parameters.DomainName.Default, "");
  for (const [name, resource] of domainResources) {
    assert.ok(["HasDomain", "HasSiteDomain", "HasAlertEmail"].includes(resource.Condition), name);
  }
  assert.equal(resources.SignalingDomain.Properties.DomainNameConfigurations[0].EndpointType, "REGIONAL");
  assert.equal(resources.SiteApexARecord.Properties.AliasTarget.HostedZoneId, "Z2FDTNDATAQYW2");
  assert.equal(resources.SiteWwwAAAARecord.Properties.Type, "AAAA");

  const viewerCertificate = resources.SiteDistribution.Properties.DistributionConfig.ViewerCertificate["Fn::If"];
  assert.equal(viewerCertificate[0], "HasSiteDomain");
  assert.equal(viewerCertificate[1].SslSupportMethod, "sni-only");
  assert.deepEqual(viewerCertificate[2], { CloudFrontDefaultCertificate: true });
});

test("the web app's CSP also allows the custom signaling host", () => {
  const csp = template.Resources.SiteResponseHeaders.Properties.ResponseHeadersPolicyConfig
    .SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy["Fn::Join"][1];
  const connect = csp.find((directive) => typeof directive === "object")["Fn::Join"][1];

  assert.deepEqual(connect[2], {
    "Fn::If": ["HasDomain", { "Fn::Sub": "wss://signal.${DomainName}" }, { Ref: "AWS::NoValue" }],
  });
});

test("cloudformation template scopes API Gateway invoke permission to the signaling API stage", () => {
  assert.equal(
    template.Resources.SignalingPermission.Properties.SourceArn["Fn::Sub"],
    "arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${SignalingApi}/${StageName}/*",
  );
});

test("keepalive pings are answered by API Gateway without invoking Lambda", () => {
  const route = template.Resources.PingRoute.Properties;
  const integration = template.Resources.PingIntegration.Properties;

  assert.equal(route.RouteKey, "ping");
  assert.deepEqual(route.Target["Fn::Join"][1][1], { Ref: "PingIntegration" });
  assert.equal(integration.IntegrationType, "MOCK");
  assert.ok(template.Resources.Stage.DependsOn.includes("PingRoute"));
});

test("cloudformation template bounds spend", () => {
  assert.deepEqual(
    template.Resources.SignalingFunction.Properties.ReservedConcurrentExecutions,
    { Ref: "MaxLambdaConcurrency" },
  );
  assert.equal(template.Parameters.ThrottlingRateLimit.Default, 200);
  assert.equal(template.Resources.SpendBudget.Condition, "HasAlertEmail");
  assert.equal(template.Parameters.AlertEmail.Default, "");
});

test("sender web app is served privately from S3 through CloudFront over HTTPS", () => {
  const bucket = template.Resources.SiteBucket.Properties;
  const distribution = template.Resources.SiteDistribution.Properties.DistributionConfig;
  const policy = template.Resources.SiteBucketPolicy.Properties.PolicyDocument.Statement[0];

  assert.deepEqual(Object.values(bucket.PublicAccessBlockConfiguration), [true, true, true, true]);
  assert.equal(distribution.DefaultCacheBehavior.ViewerProtocolPolicy, "redirect-to-https");
  assert.deepEqual(distribution.Origins[0].OriginAccessControlId, {
    "Fn::GetAtt": ["SiteOriginAccessControl", "Id"],
  });
  assert.equal(policy.Principal.Service, "cloudfront.amazonaws.com");
  assert.ok(policy.Condition.StringEquals["AWS:SourceArn"]);
});

test("sender web app may only connect to itself and the signaling API", () => {
  const headers = template.Resources.SiteResponseHeaders.Properties.ResponseHeadersPolicyConfig;
  const csp = headers.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy["Fn::Join"][1];
  const connect = csp.find((directive) => typeof directive === "object");

  assert.ok(csp.includes("default-src 'self'"));
  assert.ok(csp.includes("script-src 'self'"));
  assert.equal(connect["Fn::Join"][1][0], "connect-src 'self'");
  assert.match(connect["Fn::Join"][1][1]["Fn::Sub"], /^wss:\/\/\$\{SignalingApi\}\.execute-api/);
  assert.match(headers.CustomHeadersConfig.Items[0].Value, /display-capture=\(self\)/);
});

// The privacy policy promises this: Lambda logs are kept 14 days, and neither
// API Gateway nor CloudFront keeps access logs.
test("logs are short-lived and no access logs are kept", () => {
  const logGroup = template.Resources.SignalingLogGroup.Properties;
  const distribution = template.Resources.SiteDistribution.Properties.DistributionConfig;

  assert.equal(logGroup.RetentionInDays, 14);
  assert.deepEqual(template.Resources.SignalingFunction.Properties.LoggingConfig.LogGroup, {
    Ref: "SignalingLogGroup",
  });
  assert.equal(template.Resources.Stage.Properties.AccessLogSettings, undefined);
  assert.equal(distribution.Logging, undefined);
});

test("the Lambda messages clients through the execute-api endpoint, not the custom domain", () => {
  const variables = template.Resources.SignalingFunction.Properties.Environment.Variables;

  assert.equal(
    variables.CALLBACK_URL["Fn::Sub"],
    "https://${SignalingApi}.execute-api.${AWS::Region}.amazonaws.com/${StageName}",
  );
});
