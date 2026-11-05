import { resolve } from "node:path";
import { z } from "zod";
import { loadGoRefreshSalt, loadVaultKey } from "#local-runtime";

class WorkerSecretSetupError extends Error {
  override readonly name = "WorkerSecretSetupError";
}

const args = process.argv.slice(process.argv[2] === "--" ? 3 : 2);
const [resourcesPath] = z.tuple([z.string().min(1)]).parse(args);
const config = z
  .object({ name: z.string().regex(/^[a-z0-9-]+$/) })
  .parse(await Bun.file("wrangler.jsonc").json());
const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");
const list = Bun.spawn(["node", wrangler, "secret", "list", "--name", config.name], {
  stdout: "pipe",
  stderr: "pipe",
});
const [status, output, errorOutput] = await Promise.all([
  list.exited,
  new Response(list.stdout).text(),
  new Response(list.stderr).text(),
]);
const secretNames =
  status === 0
    ? z
        .array(z.object({ name: z.string() }))
        .parse(JSON.parse(output))
        .map((item) => item.name)
    : [];
if (status !== 0 && errorOutput.includes(`Worker "${config.name}" not found.`))
  throw new WorkerSecretSetupError("Deploy this Worker once before initializing secrets.");
if (status !== 0) throw new WorkerSecretSetupError("Cannot verify the Worker's existing secrets.");

const secrets: { GO_REFRESH_SALT: string; GO_VAULT_KEY?: string } = {
  GO_REFRESH_SALT: await loadGoRefreshSalt(resolve(resourcesPath)),
};
if (!secretNames.includes("GO_VAULT_KEY")) {
  const key = loadVaultKey(resolve("data/worker-vault.key"), false);
  secrets.GO_VAULT_KEY = Buffer.from(key).toString("base64");
}
const upload = Bun.spawn(["node", wrangler, "secret", "bulk", "--name", config.name], {
  stdin: "pipe",
  stdout: "inherit",
  stderr: "inherit",
});
upload.stdin.write(JSON.stringify(secrets));
upload.stdin.end();
const uploadStatus = await upload.exited;
if (uploadStatus !== 0)
  throw new WorkerSecretSetupError(`Worker secret upload failed (exit ${uploadStatus}).`);
