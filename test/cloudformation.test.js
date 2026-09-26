import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const templatePath = new URL(
  "../infra/cloudformation/vega-mirroring.json",
  import.meta.url,
);
const template = JSON.parse(readFileSync(templatePath, "utf8"));

test("cloudformation template keeps STUN optional", () => {
  assert.equal(template.Parameters.StunServerUrl.Default, "");
});

test("cloudformation template provisions signaling coordination resources", () => {
  assert.equal(
    template.Resources.SignalingApi.Type,
    "AWS::ApiGatewayV2::Api",
  );
  assert.equal(
    template.Resources.SignalingFunction.Type,
    "AWS::Lambda::Function",
  );
  assert.equal(
    template.Resources.SessionsTable.Type,
    "AWS::DynamoDB::Table",
  );
  assert.ok(
    template.Resources.SignalingFunction.Properties.Code.ZipFile,
    "expected inline Lambda code to be wrapped in Code.ZipFile",
  );
});

test("cloudformation template exports websocket endpoint", () => {
  assert.match(
    template.Outputs.SignalingWebSocketUrl.Value["Fn::Sub"],
    /^wss:\/\//,
  );
});

test("cloudformation template inline handler compiles as valid Python", () => {
  const [separator, lines] =
    template.Resources.SignalingFunction.Properties.Code.ZipFile["Fn::Join"];
  const source = lines.join(separator);
  const result = spawnSync(
    "python",
    ["-c", "import sys; compile(sys.stdin.read(), '<inline>', 'exec')"],
    { input: source, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
});

test("cloudformation template scopes API Gateway invoke permission to the signaling API stage", () => {
  assert.equal(
    template.Resources.SignalingPermission.Properties.SourceArn["Fn::Sub"],
    "arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${SignalingApi}/${StageName}/*",
  );
});
