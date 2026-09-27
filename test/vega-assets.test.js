import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  RECEIVER_BUNDLE_NAME,
  buildVegaAssets,
  toClassicScript,
} from "../scripts/build-vega-assets.mjs";

const TEST_CONFIG = {
  signalingEndpoint: "wss://example.execute-api.us-west-2.amazonaws.com/prod",
  stunServerUrl: "",
};

async function buildIntoTempDir(t, config = TEST_CONFIG) {
  const outDir = await mkdtemp(path.join(tmpdir(), "tandem-vega-assets-"));
  t.after(() => rm(outDir, { force: true, recursive: true }));
  await buildVegaAssets({ outDir, config });
  return outDir;
}

test("flattening strips multi-line imports and export keywords", () => {
  const source = [
    "import {",
    "  a,",
    "  b,",
    '} from "./config.js";',
    "export class Receiver {}",
    "export async function load() {}",
  ].join("\n");

  const flattened = toClassicScript(source, "sample");

  assert.doesNotMatch(flattened, /\bimport\b|\bexport\b/);
  assert.match(flattened, /^class Receiver \{\}$/m);
  assert.match(flattened, /^async function load\(\) \{\}$/m);
});

test("flattening rejects syntax it cannot rewrite", () => {
  assert.throws(
    () => toClassicScript("export default 1;", "sample"),
    /unsupported import\/export/,
  );
});

test("vega assets load the receiver as a classic script and link the probe locally", async (t) => {
  const outDir = await buildIntoTempDir(t);
  const receiverHtml = await readFile(path.join(outDir, "index.html"), "utf8");
  const probeHtml = await readFile(path.join(outDir, "probe.html"), "utf8");

  assert.match(receiverHtml, new RegExp(`<script src="./${RECEIVER_BUNDLE_NAME}"></script>`));
  assert.doesNotMatch(receiverHtml, /type="module"/);
  assert.match(receiverHtml, /href="\.\/probe\.html"/);
  assert.match(probeHtml, /href="\.\/index\.html"/);
});

test("vega receiver page embeds config without letting it close the script tag", async (t) => {
  const outDir = await buildIntoTempDir(t, {
    signalingEndpoint: "wss://example.test/</script><script>alert(1)</script>",
    stunServerUrl: "",
  });
  const receiverHtml = await readFile(path.join(outDir, "index.html"), "utf8");

  assert.equal(receiverHtml.match(/<\/script>/g).length, 2);
  assert.match(receiverHtml, /window\.TANDEM_CONFIG = \{"signalingEndpoint":"wss:\/\/example\.test\/\\u003c\/script>/);
});

test("receiver bundle runs without module imports and joins signaling with a stored code", async (t) => {
  const outDir = await buildIntoTempDir(t);
  const bundle = await readFile(path.join(outDir, RECEIVER_BUNDLE_NAME), "utf8");
  const elements = {};
  const sockets = [];

  class FakeWebSocket {
    static CLOSED = 3;
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      sockets.push(this);
    }

    addEventListener() {}
  }

  const document = {
    activeElement: null,
    addEventListener() {},
    body: { classList: { toggle() {} } },
    querySelector(selector) {
      elements[selector] ??= {
        addEventListener() {},
        classList: { toggle() {} },
        focus() {},
        hidden: true,
        textContent: "",
      };
      return elements[selector];
    },
  };
  const storage = new Map([["tandem.sessionCode", "K7P2QX"]]);

  vm.runInNewContext(bundle, {
    TANDEM_CONFIG: TEST_CONFIG,
    URL,
    URLSearchParams,
    WebSocket: FakeWebSocket,
    btoa,
    // Inert timers, so nothing scheduled by the page outlives the test.
    clearInterval() {},
    clearTimeout() {},
    setInterval() {},
    setTimeout() {},
    console,
    crypto,
    document,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    location: { search: "" },
  });

  assert.equal(elements["#session-code"].textContent, "K7P2QX");
  assert.equal(elements["#receiver-name"].textContent, "Fire TV K7P2QX");
  assert.equal(sockets.length, 1);
  const socketUrl = new URL(sockets[0].url);
  assert.equal(socketUrl.searchParams.get("sessionId"), "K7P2QX");
  assert.equal(socketUrl.searchParams.get("role"), "receiver");
  assert.equal(socketUrl.searchParams.get("name"), "Fire TV K7P2QX");
  assert.match(socketUrl.searchParams.get("receiverSecret"), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(storage.get("tandem.receiverSecret"), socketUrl.searchParams.get("receiverSecret"));
});
