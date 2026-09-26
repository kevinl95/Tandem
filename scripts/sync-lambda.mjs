// Copies infra/lambda/signaling.py into the CloudFormation template as inline
// Lambda code, so the template stays a single deployable file.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const templatePath = fileURLToPath(
  new URL("../infra/cloudformation/vega-mirroring.json", import.meta.url),
);
export const lambdaSourcePath = fileURLToPath(
  new URL("../infra/lambda/signaling.py", import.meta.url),
);

export async function syncLambda() {
  const template = JSON.parse(await readFile(templatePath, "utf8"));
  template.Resources.SignalingFunction.Properties.Code.ZipFile = await readFile(
    lambdaSourcePath,
    "utf8",
  );
  await writeFile(templatePath, `${JSON.stringify(template, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await syncLambda();
  console.log(`Synced ${lambdaSourcePath} into ${templatePath}`);
}
