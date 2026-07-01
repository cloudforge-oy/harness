/**
 * cloudcode.one harness — smoke test
 * ==================================
 * Run this FIRST, before building any UI, to confirm the installed @cline/core surface
 * matches what the harness assumes. Two phases:
 *
 *   Phase 1 (offline, no token): capability probe — asserts the SDK exports/methods exist.
 *            Catches version drift on its own. Always runs.
 *   Phase 2 (online, needs CLOUDCODE_TOKEN): one real turn through your gateway; prints the
 *            actual CoreSessionEvent types emitted and asserts a non-empty result.
 *
 * Run:
 *   npm i @cline/core@0.0.54 tsx
 *   CLOUDCODE_TOKEN=sk-... CLOUDCODE_BASE_URL=https://api.cloudcode.one \
 *     npx tsx cloudcode-smoke.ts
 *   (Phase 1 alone runs with no env set.)
 *
 * Exit code 0 = all run phases passed; 1 = a failure. Phase 2 is skipped (not failed)
 * when CLOUDCODE_TOKEN is absent.
 */

import * as Core from "@cline/core";
import { ClineCore } from "@cline/core";
import type { CoreSessionConfig, CoreSessionEvent } from "@cline/core";

// The @cline/core anthropic provider appends "/messages" to baseUrl (it expects the
// version segment to already be present), so the base MUST include /v1 — otherwise the
// gateway 404s and "Not Found" leaks through as the model's reply.
const BASE_URL = process.env.CLOUDCODE_BASE_URL ?? "https://api.cloudcode.one/v1";
const TOKEN = process.env.CLOUDCODE_TOKEN ?? "";
const MODEL = process.env.CLOUDCODE_MODEL ?? "deepseek-v4-pro";

let failures = 0;
const ok = (label: string) => console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
const bad = (label: string, err?: unknown) => {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m ${label}${err ? ` — ${String((err as Error)?.message ?? err)}` : ""}`);
};
const check = (label: string, cond: boolean) => (cond ? ok(label) : bad(label));

// ---------------------------------------------------------------------------
// Phase 1 — capability probe (offline)
// ---------------------------------------------------------------------------
async function phase1(): Promise<ClineCore | null> {
  console.log("\nPhase 1 — SDK capability probe (offline)");

  // Value exports the harness imports from the package root:
  const exportsToCheck = [
    "ClineCore",
    "InMemoryMcpManager",
    "createDefaultMcpServerClientFactory",
    "createMcpTools",
    "registerMcpServersFromSettingsFile",
    "resolveDefaultMcpSettingsPath",
  ] as const;
  for (const name of exportsToCheck) {
    check(`export "${name}" present`, typeof (Core as Record<string, unknown>)[name] !== "undefined");
  }

  check(`ClineCore.create is a function`, typeof ClineCore.create === "function");

  let cline: ClineCore | null = null;
  try {
    cline = await ClineCore.create({ clientName: "cloudcode-smoke" });
    ok("ClineCore.create() resolved");
  } catch (e) {
    bad("ClineCore.create() resolved", e);
    return null;
  }

  // Instance methods the harness calls:
  for (const m of ["start", "subscribe", "send", "stop", "dispose"] as const) {
    check(`cline.${m} is a function`, typeof (cline as unknown as Record<string, unknown>)[m] === "function");
  }

  // resolveDefaultMcpSettingsPath should return a string path:
  try {
    const p = Core.resolveDefaultMcpSettingsPath();
    check("resolveDefaultMcpSettingsPath() -> string", typeof p === "string" && p.length > 0);
  } catch (e) {
    bad("resolveDefaultMcpSettingsPath() -> string", e);
  }

  return cline;
}

// ---------------------------------------------------------------------------
// Phase 2 — one live turn through the gateway (online)
// ---------------------------------------------------------------------------
async function phase2(cline: ClineCore): Promise<void> {
  console.log("\nPhase 2 — live gateway turn");
  if (!TOKEN) {
    console.log("  \x1b[33mSKIP\x1b[0m no CLOUDCODE_TOKEN set — skipping live run");
    return;
  }

  // Build the config INLINE (a second, independent check that the field names still typecheck).
  const config = {
    providerId: "anthropic",
    modelId: MODEL,
    apiKey: TOKEN,
    baseUrl: BASE_URL,
    systemPrompt: "You are a smoke test. Answer in one word.",
    cwd: process.cwd(),
    mode: "act",
    enableTools: true,
    enableSpawnAgent: false,
    enableAgentTeams: false,
    // Approval plumbing — auto-approve here; if the model calls a tool we'll see the log line.
    toolPolicies: { bash: { autoApprove: false } },
    hooks: {
      beforeTool: async (ctx: any) => {
        console.log(`    [approval] tool requested: ${ctx?.tool?.name ?? ctx?.toolCall?.toolName} -> auto-approving`);
        return undefined; // approve
      },
    },
  } as CoreSessionConfig;

  const seenTypes = new Set<string>();
  const unsubscribe = cline.subscribe((event: CoreSessionEvent) => {
    seenTypes.add((event as { type: string }).type);
  });

  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("timed out after 90s")), 90_000),
  );

  try {
    const result = (await Promise.race([
      cline.start({
        config,
        prompt: 'Reply with exactly one word: "pong". Do not use any tools.',
        interactive: false, // blocks and returns the final AgentResult
      }),
      timeout,
    ])) as Awaited<ReturnType<ClineCore["start"]>>;

    ok("cline.start() completed a turn");
    check("StartSessionResult.sessionId is a string", typeof result.sessionId === "string");

    const text = result.result?.text ?? "";
    check("final result text is non-empty", text.trim().length > 0);
    console.log(`    model said: ${JSON.stringify(text.slice(0, 120))}`);

    // The most useful drift signal: the event types the runtime actually emitted.
    console.log(`    observed event types: [${[...seenTypes].join(", ") || "(none)"}]`);
    check("received at least one streamed event", seenTypes.size > 0);

    await cline.stop(result.sessionId).catch(() => {});
  } catch (e) {
    bad("live gateway turn", e);
    console.log("    (check: gateway reachable? token valid? model id accepted? /v1/messages implemented?)");
  } finally {
    unsubscribe();
  }
}

// ---------------------------------------------------------------------------
(async () => {
  console.log("cloudcode.one harness smoke test — @cline/core");
  const cline = await phase1();
  if (cline) {
    await phase2(cline);
    await cline.dispose().catch(() => {});
  } else {
    console.log("\nPhase 2 skipped — core did not initialize.");
  }

  console.log(
    failures === 0
      ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m"
      : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m — fix imports/signatures before building on top.`,
  );
  process.exit(failures === 0 ? 0 : 1);
})();
