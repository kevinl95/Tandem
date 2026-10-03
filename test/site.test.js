import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { APK_PATH, buildSite } from "../scripts/build-site.mjs";

const ENDPOINT = "wss://abc123.execute-api.us-west-2.amazonaws.com/prod";
const CONTACT = "support@example.com";

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "tandem-site-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  return dir;
}

test("site build rewrites the page's imports and config path for hosting", async (t) => {
  const outDir = await tempDir(t);
  await buildSite({ apkSource: null, contactEmail: CONTACT, outDir, signalingEndpoint: ENDPOINT });

  const app = await readFile(path.join(outDir, "app.js"), "utf8");
  assert.match(app, /from "\.\/src\/receiver\/config\.js"/);
  assert.match(app, /from "\.\/src\/sender\/sender\.js"/);
  assert.match(app, /const CONFIG_URL = "config\.json";/);
  assert.doesNotMatch(app, /\.\.\//);

  // The rewritten import targets exist, and sender.js's own relative import resolves.
  const sender = await readFile(path.join(outDir, "src/sender/sender.js"), "utf8");
  assert.match(sender, /from "\.\.\/receiver\/config\.js"/);
  await stat(path.join(outDir, "src/receiver/config.js"));
});

test("site build writes the endpoint config and a valid manifest with its icons", async (t) => {
  const outDir = await tempDir(t);
  await buildSite({ apkSource: null, contactEmail: CONTACT, outDir, signalingEndpoint: ENDPOINT });

  const config = JSON.parse(await readFile(path.join(outDir, "config.json"), "utf8"));
  assert.deepEqual(config, { signalingEndpoint: ENDPOINT });

  const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.display, "standalone");
  for (const icon of manifest.icons) {
    await stat(path.join(outDir, icon.src));
  }
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable"));
});

test("site build hosts every image the page references, since the CSP blocks other origins", async (t) => {
  const outDir = await tempDir(t);
  await buildSite({ apkSource: null, contactEmail: CONTACT, outDir, signalingEndpoint: ENDPOINT });

  const html = await readFile(path.join(outDir, "index.html"), "utf8");
  const images = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map(([, src]) => src);
  assert.ok(images.length >= 2);
  for (const src of images) {
    assert.doesNotMatch(src, /^https?:/, `${src} must be served from the site`);
    await stat(path.join(outDir, src));
  }
});

test("site build publishes the APK and links it when one is built", async (t) => {
  const outDir = await tempDir(t);
  const apkSource = path.join(await tempDir(t), "app-debug.apk");
  await writeFile(apkSource, "fake apk");

  const config = await buildSite({ apkSource, contactEmail: CONTACT, outDir, signalingEndpoint: ENDPOINT });

  assert.equal(config.apkUrl, APK_PATH);
  assert.equal(await readFile(path.join(outDir, APK_PATH), "utf8"), "fake apk");
});

test("site build refuses to run without a signaling endpoint", async (t) => {
  await assert.rejects(buildSite({ outDir: await tempDir(t) }), /signaling endpoint is required/);
});

test("site build publishes the privacy policy with the contact email filled in", async (t) => {
  const outDir = await tempDir(t);
  await buildSite({ apkSource: null, contactEmail: CONTACT, outDir, signalingEndpoint: ENDPOINT });

  const privacy = await readFile(path.join(outDir, "privacy.html"), "utf8");
  assert.doesNotMatch(privacy, /\{\{/);
  assert.match(privacy, /mailto:support@example\.com/);
});

test("site build refuses to publish the privacy policy without a real contact email", async (t) => {
  for (const contactEmail of [undefined, "", "{{CONTACT_EMAIL}}", "not an email"]) {
    await assert.rejects(
      buildSite({ apkSource: null, contactEmail, outDir: await tempDir(t), signalingEndpoint: ENDPOINT }),
      /TANDEM_CONTACT_EMAIL/,
    );
  }
});
