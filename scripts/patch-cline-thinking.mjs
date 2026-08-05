/**
 * Postinstall patch for @cline/llms: keep GLM's thinking blocks across turns.
 *
 * z.ai calls this "preserved thinking" — the model keeps the reasoning from
 * earlier assistant turns in context instead of it being dropped, which keeps
 * a coding loop coherent and lifts cache hits
 * (https://docs.z.ai/guides/capabilities/thinking-mode). It only works if the
 * client sends every reasoning block back **unmodified** on the next turn. The
 * Anthropic wire format carries them as `thinking` blocks, each with the
 * `signature` the server issued for it.
 *
 * Two bugs in @cline/llms 0.0.54 lose that signature while streaming, so the
 * AI SDK drops every thinking block when it builds the next request
 * ("AI SDK Warning (anthropic / glm-5.2): unsupported reasoning metadata") and
 * the model never sees its own reasoning again:
 *
 * 1. The AI SDK reports a thinking block's signature as a reasoning-delta with
 *    an EMPTY text delta and `providerMetadata.anthropic.signature` set (that's
 *    how `signature_delta` surfaces). The stream mapper only yields a
 *    reasoning-delta when the text is non-empty, so the signature-carrying
 *    delta is skipped entirely. Patch: also yield when the delta carries
 *    metadata, with the text defaulting to "".
 *
 * 2. The metadata extractor picks up Google/Vertex `thoughtSignature` but never
 *    `providerMetadata.anthropic.signature`, so even a forwarded delta would
 *    arrive without the field the request builder looks for (`metadata.signature`).
 *    Patch: extract the Anthropic signature (and redacted-thinking data) too.
 *
 * Both are provider-generic — this is the same round trip Claude's extended
 * thinking needs — but GLM through the cloudcode gateway is where it bites,
 * since GLM-5.x thinks on every turn by default.
 *
 * Idempotent; fails the install loudly if an anchor can't be found (i.e. a
 * @cline version bump changed the code — re-verify this patch then).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "__ccKeepThinkingSignature";

let failures = 0;

function pkgDistFiles(spec) {
  let entry;
  try {
    // ESM resolve — the package's exports map is import-only.
    entry = fileURLToPath(import.meta.resolve(spec));
  } catch {
    console.log(`patch-cline-thinking: ${spec} not installed, skipping`);
    return null;
  }
  const dist = path.dirname(entry);
  return fs
    .readdirSync(dist, { recursive: true })
    .filter((f) => f.endsWith(".js") || f.endsWith(".mjs"))
    .map((f) => path.join(dist, f));
}

const ID = "([A-Za-z_$][\\w$]*)";

// ---------------------------------------------------------------------------
// Patch 1 — extract providerMetadata.anthropic.signature into part metadata.
// Anchor (minified names vary per build, so match structurally):
//   function Bs(e){let t={};if(typeof e.thoughtSignature==="string")
//     t.thoughtSignature=e.thoughtSignature;
// ---------------------------------------------------------------------------
function patchSignatureExtractor(src) {
  const anchor = new RegExp(
    `function ${ID}\\(${ID}\\)\\{let ${ID}=\\{\\};` +
      `if\\(typeof \\2\\.thoughtSignature==="string"\\)\\3\\.thoughtSignature=\\2\\.thoughtSignature;`,
  );
  return src.replace(
    anchor,
    (full, _fn, part, out) =>
      full +
      `{let ${MARKER}=${part}?.providerMetadata?.anthropic;` +
      `if(${MARKER}&&typeof ${MARKER}==="object"){` +
      `if(typeof ${MARKER}.signature==="string")${out}.signature=${MARKER}.signature;` +
      `if(typeof ${MARKER}.redactedData==="string")${out}.redactedData=${MARKER}.redactedData;}}`,
  );
}

// ---------------------------------------------------------------------------
// Patch 2 — forward reasoning deltas that carry metadata but no text.
// Anchor (minified):
//   if(p.type==="reasoning-delta"||p.type==="reasoning"){
//     let h=p.textDelta??p.text??p.reasoning;
//     if(h)yield{type:"reasoning-delta",text:h,metadata:Bs(p)};continue}
// ---------------------------------------------------------------------------
function patchReasoningDelta(src) {
  const anchor = new RegExp(
    `if\\(${ID}\\.type==="reasoning-delta"\\|\\|\\1\\.type==="reasoning"\\)\\{` +
      `let ${ID}=\\1\\.textDelta\\?\\?\\1\\.text\\?\\?\\1\\.reasoning;` +
      `if\\(\\2\\)yield\\{type:"reasoning-delta",text:\\2,metadata:${ID}\\(\\1\\)\\};continue\\}`,
  );
  return src.replace(
    anchor,
    (_full, part, text, extract) =>
      `if(${part}.type==="reasoning-delta"||${part}.type==="reasoning"){` +
      `let ${text}=${part}.textDelta??${part}.text??${part}.reasoning,` +
      `${MARKER}m=${extract}(${part});` +
      `if(${text}||${MARKER}m)yield{type:"reasoning-delta",text:${text}??"",metadata:${MARKER}m};continue}`,
  );
}

function patchLlmsThinkingSignature() {
  const files = pkgDistFiles("@cline/llms");
  if (!files) return;

  let patched = 0;
  let already = 0;
  let partial = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    if (src.includes(MARKER)) {
      already++;
      continue;
    }
    const withExtractor = patchSignatureExtractor(src);
    const next = patchReasoningDelta(withExtractor);
    if (next === src) continue; // this dist file doesn't bundle the stream mapper
    if (withExtractor === src || next === withExtractor) {
      console.error(
        `patch-cline-thinking: only one of the two anchors matched in ${file} — the code changed; re-verify this patch`,
      );
      partial++;
      continue;
    }
    fs.writeFileSync(file, next);
    patched++;
    console.log(`patch-cline-thinking: thinking-signature round trip -> ${file}`);
  }
  if (partial > 0) failures++;
  if (patched === 0 && already === 0 && partial === 0) {
    console.error(
      "patch-cline-thinking: reasoning-delta anchor not found in any @cline/llms dist file — the code changed; re-verify this patch",
    );
    failures++;
  } else if (already > 0 && patched === 0) {
    console.log("patch-cline-thinking: @cline/llms already patched");
  }
}

patchLlmsThinkingSignature();
process.exit(failures > 0 ? 1 : 0);
