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

async function buildIntoTempDir(t) {
  const outDir = await mkdtemp(path.join(tmpdir(), "tandem-vega-assets-"));
  t.after(() => rm(outDir, { force: true, recursive: true }));
  await buildVegaAssets({ outDir });
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

test("receiver bundle runs without module imports and wires up the page", async (t) => {
  const outDir = await buildIntoTempDir(t);
  const bundle = await readFile(path.join(outDir, RECEIVER_BUNDLE_NAME), "utf8");
  const listeners = {};

  const document = {
    querySelector(selector) {
      return {
        addEventListener(name, listener) {
          listeners[`${selector}:${name}`] = listener;
        },
        value: "",
      };
    },
  };

  vm.runInNewContext(bundle, { JSON, URL, console, document });

  assert.equal(typeof listeners["#accept-offer:click"], "function");
  assert.equal(typeof listeners["#connect-signaling:click"], "function");
});
