/**
 * Postinstall patch for @cline/agents: lenient tool-argument parsing.
 *
 * The agent runtime strict-JSON.parses the tool-call arguments streamed from
 * the model and fails the tool call outright when they don't parse ("Tool call
 * X emitted invalid JSON arguments"). Weaker models (deepseek-v4-flash)
 * routinely emit large editor payloads with unescaped quotes/newlines or
 * truncated JSON, making the editor tool unusable. There is no hook to
 * intercept the raw text, so this patches the parser in
 * node_modules/@cline/agents/dist/index.js to try jsonrepair before giving up.
 *
 * Idempotent; fails the install loudly if the anchor can't be found (i.e. a
 * @cline version bump changed the code — re-verify the patch then).
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const MARKER = "__ccJsonRepair";

let file;
try {
  // ESM resolve — the package's exports map is import-only, so require.resolve throws.
  file = fileURLToPath(import.meta.resolve("@cline/agents"));
} catch {
  console.log("patch-cline-agents: @cline/agents not installed, nothing to do");
  process.exit(0);
}

let src = fs.readFileSync(file, "utf8");
if (src.includes(MARKER)) {
  console.log("patch-cline-agents: already patched");
  process.exit(0);
}

// The strict parser (minified names vary per build, so match structurally):
//   function dv(e){let i=e.trim();if(!i)return{ok:!1,error:"Tool call arguments
//   were empty."};try{return{ok:!0,value:JSON.parse(i)}}catch{} ...
const anchor =
  /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.trim\(\);if\(!\1\)return\{ok:!1,error:"Tool call arguments were empty\."\};try\{return\{ok:!0,value:JSON\.parse\(\1\)\}\}catch\{\}/;

const match = src.match(anchor);
if (!match) {
  console.error(
    `patch-cline-agents: anchor not found in ${file} — the @cline/agents parser changed; re-verify scripts/patch-cline-agents.mjs against the new version`,
  );
  process.exit(1);
}

src = src.replace(
  anchor,
  `$&try{return{ok:!0,value:JSON.parse(${MARKER}(${match[1]})),repaired:!0}}catch{}`,
);
src = `import{jsonrepair as ${MARKER}}from"jsonrepair";` + src;

fs.writeFileSync(file, src);
console.log(`patch-cline-agents: patched ${file}`);
