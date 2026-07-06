/**
 * Transpile cloudcode-harness.ts -> cloudcode-harness.js (plain ESM) so the
 * packaged app can run it without tsx/esbuild at runtime. esbuild's native
 * binary is platform-specific; compiling here (once, on the build host)
 * produces platform-neutral JS that runs on any OS the app is packaged for.
 *
 * Not bundled: imports of @cline/core stay as runtime imports resolved from
 * the packaged node_modules; only TypeScript syntax is stripped.
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [path.join(root, "cloudcode-harness.ts")],
  outfile: path.join(root, "cloudcode-harness.js"),
  platform: "node",
  format: "esm",
  target: "node20",
  bundle: false,
  sourcemap: false,
  logLevel: "info",
});

console.log("compiled cloudcode-harness.ts -> cloudcode-harness.js");
