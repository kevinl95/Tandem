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

test("cloudformation template exports websocket endpoint", () => {
  assert.match(template.Outputs.SignalingWebSocketUrl.Value["Fn::Sub"], /^wss:\/\//);
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
