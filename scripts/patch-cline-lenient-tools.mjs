/**
 * Postinstall patch for @cline/llms + @cline/core: weak-model tool leniency.
 *
 * Two library behaviors make built-in tools unusable for weak models
 * (glm-4.7-flash and friends):
 *
 * 1. @cline/llms validates every tool call against the tool's strict JSON
 *    schema BEFORE execution (zod fromJSONSchema), and hard-rejects on any
 *    mismatch ("Tool call read_files was rejected before execution"). The
 *    tools' own execute() functions deliberately accept lenient input shapes
 *    (e.g. read_files coerces "files":["a.txt"] strings into {path} objects),
 *    but they never get the chance. Patch: on validation failure pass the raw
 *    parsed input through to execute(), whose own zod parsing turns genuinely
 *    bad input into a normal, model-recoverable tool error.
 *
 * 2. @cline/core's editor tool rejects old_text/new_text over 6000 chars
 *    ("Editor input too large ... recommended limit"). Weak models routinely
 *    emit a whole ~10k-char file in one call and then spiral trying to split
 *    it. By the time this check runs the payload has already survived JSON
 *    parsing intact, so accepting it is safe. Patch: raise the limit to 48000
 *    (the same cap core uses for tool output truncation).
 *
 * 3. The AI SDK ("ai" package, used by @cline/llms) JSON-parses tool-call
 *    arguments in doParseToolCall and hard-rejects on malformed JSON
 *    ("Invalid input for tool editor: JSON parsing failed") — a parse site the
 *    @cline/agents jsonrepair patch (scripts/patch-cline-agents.mjs) does not
 *    cover. Patch: on parse failure retry once with jsonrepair before
 *    rejecting.
 *
 * 4. @cline/core's shell executor treats ANY structured run_commands entry as
 *    a direct spawn: {"command":"ls -la","args":[]} spawns a binary literally
 *    named "ls -la" ("Failed to execute command: spawn ls -la ENOENT"). Weak
 *    models emit args:[] constantly. Patch: route entries with empty/absent
 *    args through the shell like plain command strings.
 *
 * 5. @cline/core's hub-daemon launcher spawns `process.execPath entry.js ...`.
 *    In a packaged Electron app, execPath is the Harness binary itself, which
 *    ignores the script argument and boots a second app window on the first
 *    session start. Patch: add ELECTRON_RUN_AS_NODE=1 to the daemon child's
 *    env (scoped to that spawn only) so the binary runs entry.js as Node.
 *
 * Idempotent; fails the install loudly if an anchor can't be found (i.e. a
 * @cline version bump changed the code — re-verify this patch then).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LENIENT_MARKER = "__ccLenientToolInput";
const EDITOR_LIMIT = 48000;

let failures = 0;

function pkgDistFiles(spec) {
  let entry;
  try {
    // ESM resolve — the packages' exports maps are import-only.
    entry = fileURLToPath(import.meta.resolve(spec));
  } catch {
    console.log(`patch-cline-lenient-tools: ${spec} not installed, skipping`);
    return null;
  }
  const dist = path.dirname(entry);
  return fs
    .readdirSync(dist, { recursive: true })
    .filter((f) => f.endsWith(".js") || f.endsWith(".mjs"))
    .map((f) => path.join(dist, f));
}

// ---------------------------------------------------------------------------
// Patch 1 — @cline/llms: lenient pre-execution tool-input validation.
// Anchor (minified names vary per build, so match structurally):
//   validate:async(n)=>{let r=await Vz.fromJSONSchema(t.inputSchema)
//     .safeParseAsync(n);return r.success?{success:!0,value:r.data}
//     :{success:!1,error:r.error}}
// ---------------------------------------------------------------------------
function patchLlms() {
  const files = pkgDistFiles("@cline/llms");
  if (!files) return;

  const id = "[A-Za-z_$][\\w$]*";
  const anchor = new RegExp(
    `validate:async\\((${id})\\)=>\\{let (${id})=await (${id})\\.fromJSONSchema\\((${id})\\.inputSchema\\)` +
      `\\.safeParseAsync\\(\\1\\);return \\2\\.success\\?\\{success:!0,value:\\2\\.data\\}:\\{success:!1,error:\\2\\.error\\}\\}`,
    "g",
  );

  let patched = 0;
  let already = 0;
  for (const file of files) {
    let src = fs.readFileSync(file, "utf8");
    if (src.includes(LENIENT_MARKER)) {
      already++;
      continue;
    }
    let hits = 0;
    src = src.replace(anchor, (_m, input, res, zodNs, tool) => {
      hits++;
      return (
        `validate:async(${input})=>{let ${res}=await ${zodNs}.fromJSONSchema(${tool}.inputSchema)` +
        `.safeParseAsync(${input});return ${res}.success?{success:!0,value:${res}.data}` +
        `:{success:!0,value:${input}/*${LENIENT_MARKER}*/}}`
      );
    });
    if (hits > 0) {
      fs.writeFileSync(file, src);
      patched++;
      console.log(`patch-cline-lenient-tools: lenient validation -> ${file} (${hits} site(s))`);
    }
  }
  if (patched === 0 && already === 0) {
    console.error(
      "patch-cline-lenient-tools: validation anchor not found in any @cline/llms dist file — the code changed; re-verify this patch",
    );
    failures++;
  } else if (already > 0 && patched === 0) {
    console.log("patch-cline-lenient-tools: @cline/llms already patched");
  }
}

// ---------------------------------------------------------------------------
// Patch 2 — @cline/core: raise the editor input-size limit.
// The limit variable's minified name is recovered from the error template
// ("recommended limit of ${g1}") in each dist file, then its `=6000`
// assignment is bumped.
// ---------------------------------------------------------------------------
function patchCoreEditorLimit() {
  const files = pkgDistFiles("@cline/core");
  if (!files) return;

  let patched = 0;
  let already = 0;
  let missed = 0;
  for (const file of files) {
    let src = fs.readFileSync(file, "utf8");
    const tmpl = src.match(/recommended limit of \$\{([A-Za-z_$][\w$]*)\}/);
    if (!tmpl) continue; // this dist file doesn't bundle the editor tool
    const name = tmpl[1].replace(/\$/g, "\\$");
    if (new RegExp(`\\b${name}=${EDITOR_LIMIT}\\b`).test(src)) {
      already++;
      continue;
    }
    const assignment = new RegExp(`\\b${name}=6000\\b`);
    if (!assignment.test(src)) {
      console.error(
        `patch-cline-lenient-tools: editor limit template found in ${file} but no ${tmpl[1]}=6000 assignment — re-verify this patch`,
      );
      missed++;
      continue;
    }
    src = src.replace(assignment, () => `${tmpl[1]}=${EDITOR_LIMIT}`);
    fs.writeFileSync(file, src);
    patched++;
    console.log(`patch-cline-lenient-tools: editor limit 6000 -> ${EDITOR_LIMIT} in ${file}`);
  }
  if (missed > 0) failures++;
  if (patched === 0 && already === 0 && missed === 0) {
    console.error(
      "patch-cline-lenient-tools: editor limit anchor not found in any @cline/core dist file — the code changed; re-verify this patch",
    );
    failures++;
  } else if (already > 0 && patched === 0) {
    console.log("patch-cline-lenient-tools: @cline/core already patched");
  }
}

// ---------------------------------------------------------------------------
// Patch 3 — ai package: jsonrepair fallback in doParseToolCall.
// Anchor (unminified; CJS uses `(0, import_x.safeParseJSON)`, ESM plain
// `safeParseJSON3`-style identifiers):
//   const parseResult = toolCall.input.trim() === "" ? await safeValidateTypes4(
//     { value: {}, schema }) : await safeParseJSON3({ text: toolCall.input, schema });
// ---------------------------------------------------------------------------
const AI_MARKER = "__ccJsonRepairAi";

function patchAiJsonRepair() {
  const files = pkgDistFiles("ai");
  if (!files) return;

  const callee = "(?:\\(0, [\\w$]+\\.safeParseJSON\\)|safeParseJSON\\d*)";
  const validatee = "(?:\\(0, [\\w$]+\\.safeValidateTypes\\)|safeValidateTypes\\d*)";
  const anchor = new RegExp(
    `const parseResult = toolCall\\.input\\.trim\\(\\) === "" \\? await ${validatee}\\(\\{ value: \\{\\}, schema \\}\\)` +
      ` : await (${callee})\\(\\{ text: toolCall\\.input, schema \\}\\);`,
  );

  let patched = 0;
  let already = 0;
  for (const file of files) {
    let src = fs.readFileSync(file, "utf8");
    if (src.includes(AI_MARKER)) {
      already++;
      continue;
    }
    const m = src.match(anchor);
    if (!m) continue;
    src = src.replace(
      anchor,
      (full, parseCallee) =>
        "let" +
        full.slice("const".length) +
        `if (parseResult.success === false) { try { parseResult = await ${parseCallee}({ text: ${AI_MARKER}(toolCall.input), schema }); } catch {} }`,
    );
    src = file.endsWith(".mjs")
      ? `import{jsonrepair as ${AI_MARKER}}from"jsonrepair";` + src
      : src.replace(/^("use strict";)?/, `$1var ${AI_MARKER}=require("jsonrepair").jsonrepair;`);
    fs.writeFileSync(file, src);
    patched++;
    console.log(`patch-cline-lenient-tools: jsonrepair fallback -> ${file}`);
  }
  if (patched === 0 && already === 0) {
    console.error(
      "patch-cline-lenient-tools: doParseToolCall anchor not found in any ai dist file — the code changed; re-verify this patch",
    );
    failures++;
  } else if (already > 0 && patched === 0) {
    console.log("patch-cline-lenient-tools: ai already patched");
  }
}

// ---------------------------------------------------------------------------
// Patch 4 — @cline/core: shell-execute structured commands with empty args.
// Anchor (minified):
//   return(Y,j,V)=>{let H=typeof Y!=="string";return BL({executable:H?Y.command:Z,
//     args:H?Y.args??[]:HL(Z,Y),cwd:j,env:W},V,Q,X,J)}
// ---------------------------------------------------------------------------
const SHELL_MARKER = "__ccEmptyArgsShell";

function patchCoreEmptyArgsShell() {
  const files = pkgDistFiles("@cline/core");
  if (!files) return;

  const id = "([A-Za-z_$][\\w$]*)";
  const anchor = new RegExp(
    `return\\(${id},${id},${id}\\)=>\\{let ${id}=typeof \\1!=="string";` +
      `return ${id}\\(\\{executable:\\4\\?\\1\\.command:${id},args:\\4\\?\\1\\.args\\?\\?\\[\\]:${id}\\(\\6,\\1\\),cwd:\\2,env:${id}\\},\\3,${id},${id},${id}\\)\\}`,
  );

  let patched = 0;
  let already = 0;
  for (const file of files) {
    let src = fs.readFileSync(file, "utf8");
    if (src.includes(SHELL_MARKER)) {
      already++;
      continue;
    }
    if (!anchor.test(src)) continue;
    src = src.replace(
      anchor,
      (_full, input, cwd, sig, structured, run, shell, toArgs, env, t1, t2, t3) =>
        `return(${input},${cwd},${sig})=>{let ${structured}=typeof ${input}!=="string"` +
        `&&Array.isArray(${input}.args)&&${input}.args.length>0;/*${SHELL_MARKER}*/` +
        `return ${run}({executable:${structured}?${input}.command:${shell},` +
        `args:${structured}?${input}.args:${toArgs}(${shell},typeof ${input}==="string"?${input}:${input}.command),` +
        `cwd:${cwd},env:${env}},${sig},${t1},${t2},${t3})}`,
    );
    fs.writeFileSync(file, src);
    patched++;
    console.log(`patch-cline-lenient-tools: empty-args shell exec -> ${file}`);
  }
  if (patched === 0 && already === 0) {
    console.error(
      "patch-cline-lenient-tools: shell executor anchor not found in any @cline/core dist file — the code changed; re-verify this patch",
    );
    failures++;
  } else if (already > 0 && patched === 0) {
    console.log("patch-cline-lenient-tools: @cline/core shell executor already patched");
  }
}

// ---------------------------------------------------------------------------
// Patch 5 — @cline/core: run the hub daemon child as Node under Electron.
// Anchor (minified): env:{...VR(process.env),CLINE_NO_INTERACTIVE:"1"
// ---------------------------------------------------------------------------
function patchCoreDaemonRunAsNode() {
  const files = pkgDistFiles("@cline/core");
  if (!files) return;

  const anchor = /env:\{\.\.\.([A-Za-z_$][\w$]*)\(process\.env\),CLINE_NO_INTERACTIVE:"1"/;
  const marker = 'ELECTRON_RUN_AS_NODE:"1",CLINE_NO_INTERACTIVE:"1"';

  let patched = 0;
  let already = 0;
  for (const file of files) {
    let src = fs.readFileSync(file, "utf8");
    if (src.includes(marker)) {
      already++;
      continue;
    }
    if (!anchor.test(src)) continue;
    src = src.replace(anchor, (_full, envFilter) => `env:{...${envFilter}(process.env),${marker}`);
    fs.writeFileSync(file, src);
    patched++;
    console.log(`patch-cline-lenient-tools: daemon ELECTRON_RUN_AS_NODE -> ${file}`);
  }
  if (patched === 0 && already === 0) {
    console.error(
      "patch-cline-lenient-tools: hub daemon env anchor not found in any @cline/core dist file — the code changed; re-verify this patch",
    );
    failures++;
  } else if (already > 0 && patched === 0) {
    console.log("patch-cline-lenient-tools: @cline/core daemon env already patched");
  }
}

patchLlms();
patchCoreEditorLimit();
patchAiJsonRepair();
patchCoreEmptyArgsShell();
patchCoreDaemonRunAsNode();
process.exit(failures > 0 ? 1 : 0);
