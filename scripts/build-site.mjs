// Assembles the hosted sender site (a PWA) into dist/site for S3/CloudFront:
//
//   index.html, app.js, sw.js, manifest.webmanifest, icons/   from public/sender
//   privacy.html                                             with the contact email filled in
//   src/receiver/config.js, src/sender/sender.js             ES modules it imports
//   config.json                                              signaling endpoint (+ APK link)
//   downloads/tandem.apk                                     Android app, if built
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_OUT_DIR = path.join(repoRoot, "dist", "site");
// The signed release build when it exists (see README: Android release
// signing), otherwise the debug build.
const RELEASE_APK = path.join(repoRoot, "android-sender/app/build/outputs/apk/release/app-release.apk");
const DEBUG_APK = path.join(repoRoot, "android-sender/app/build/outputs/apk/debug/app-debug.apk");
export const APK_SOURCE = existsSync(RELEASE_APK) ? RELEASE_APK : DEBUG_APK;
export const APK_PATH = "downloads/tandem.apk";

function replaceExactlyOnce(source, searchValue, replaceValue, label) {
  const occurrences = source.split(searchValue).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${label}: expected exactly one occurrence of ${JSON.stringify(searchValue)}, found ${occurrences}`,
    );
  }
  return source.replace(searchValue, replaceValue);
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

const EMAIL_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export async function buildSite({
  outDir = DEFAULT_OUT_DIR,
  signalingEndpoint,
  contactEmail,
  apkSource = APK_SOURCE,
}) {
  if (!signalingEndpoint) {
    throw new Error("A signaling endpoint is required; deploy the stack first.");
  }
  // The privacy policy must name a real contact; never publish the placeholder.
  if (!EMAIL_PATTERN.test(contactEmail ?? "")) {
    throw new Error("Set TANDEM_CONTACT_EMAIL to the support email the privacy policy should list.");
  }

  await rm(outDir, { force: true, recursive: true });
  await mkdir(path.join(outDir, "icons"), { recursive: true });
  await mkdir(path.join(outDir, "src/receiver"), { recursive: true });
  await mkdir(path.join(outDir, "src/sender"), { recursive: true });

  const senderDir = path.join(repoRoot, "public/sender");
  // In the repo the page lives two levels below src/ and the config file;
  // on the site they sit next to it.
  let app = await readFile(path.join(senderDir, "app.js"), "utf8");
  app = replaceExactlyOnce(app, `from "../../src/receiver/config.js"`, `from "./src/receiver/config.js"`, "app.js");
  app = replaceExactlyOnce(app, `from "../../src/sender/sender.js"`, `from "./src/sender/sender.js"`, "app.js");
  app = replaceExactlyOnce(app, `"../../tandem.config.json"`, `"config.json"`, "app.js");

  await writeFile(path.join(outDir, "app.js"), app);
  for (const file of ["index.html", "sw.js", "manifest.webmanifest"]) {
    await copyFile(path.join(senderDir, file), path.join(outDir, file));
  }
  const privacy = await readFile(path.join(senderDir, "privacy.html"), "utf8");
  await writeFile(path.join(outDir, "privacy.html"), privacy.replaceAll("{{CONTACT_EMAIL}}", contactEmail));
  for (const icon of await readdir(path.join(senderDir, "icons"))) {
    await copyFile(path.join(senderDir, "icons", icon), path.join(outDir, "icons", icon));
  }
  await copyFile(path.join(repoRoot, "src/receiver/config.js"), path.join(outDir, "src/receiver/config.js"));
  await copyFile(path.join(repoRoot, "src/sender/sender.js"), path.join(outDir, "src/sender/sender.js"));

  const config = { signalingEndpoint };
  if (apkSource && (await exists(apkSource))) {
    await mkdir(path.join(outDir, "downloads"), { recursive: true });
    await copyFile(apkSource, path.join(outDir, APK_PATH));
    config.apkUrl = APK_PATH;
  }
  await writeFile(path.join(outDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

  return config;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { signalingEndpoint } = JSON.parse(
    await readFile(path.join(repoRoot, "tandem.config.json"), "utf8"),
  );
  const config = await buildSite({ contactEmail: process.env.TANDEM_CONTACT_EMAIL, signalingEndpoint });
  console.log(`Built ${DEFAULT_OUT_DIR}${config.apkUrl ? " (with the Android APK)" : " (no APK built; skipping download)"}`);
}
