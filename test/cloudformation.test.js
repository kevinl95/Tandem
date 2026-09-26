import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const templatePath =
  "/home/runner/work/Tandem/Tandem/infra/cloudformation/vega-mirroring.json";
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
});

test("cloudformation template exports websocket endpoint", () => {
  assert.match(
    template.Outputs.SignalingWebSocketUrl.Value["Fn::Sub"],
    /^wss:\/\//,
  );
});
