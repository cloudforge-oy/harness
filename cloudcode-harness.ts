/**
 * cloudcode.one — agent harness on @cline/core  (with tool approval + MCP)
 * =======================================================================
 * Verified against cline/cline@main, @cline/core 0.0.54. Key API surface:
 *   ClineCore.create(options)          -> core instance (telemetry omitted = silent)
 *   cline.start({ config, prompt, ... })-> StartSessionResult { sessionId, result? }
 *   cline.subscribe(listener)          -> unsubscribe   (streaming CoreSessionEvent)
 *   cline.send({ sessionId, prompt, mode })                (follow-up turns)
 *   cline.stop(sessionId)              -> graceful session stop (NOT stopSession)
 *
 * CoreSessionConfig approval levers (both verified settable):
 *   toolPolicies?: Record<string,{ enabled?; autoApprove? }>   // "*" = wildcard
 *   hooks?: AgentHooks  ( = Partial<AgentRuntimeHooks>: beforeTool/afterTool/... )
 *
 * MCP (traced via runtime/orchestration/runtime-builder.ts):
 *   - file path: servers auto-loaded from resolveDefaultMcpSettingsPath()
 *   - programmatic: InMemoryMcpManager + registerServer + createMcpTools
 *
 * package.json: { "dependencies": { "@cline/core": "0.0.54" } }  // pin — it's 0.0.x/experimental
 */

import { ClineCore } from "@cline/core";
// MCP primitives live under @cline/core's mcp extension. Adjust the import path/names
// if the published entrypoint differs (pre-1.0 surface can move between releases).
import {
  InMemoryMcpManager,
  createDefaultMcpServerClientFactory,
  createMcpTools,
  registerMcpServersFromSettingsFile,
  resolveDefaultMcpSettingsPath,
} from "@cline/core";
import type {
  CoreSessionConfig,
  CoreSessionEvent,
  McpServerRegistration,
} from "@cline/core";

// NOTE: the beforeTool context/result types live in @cline/shared in 0.0.54, NOT @cline/core.
// Instead of importing them by name (they can move/rename pre-1.0), derive them straight from
// the config's own hook type so this stays correct no matter where they're defined:
type BeforeToolFn = NonNullable<NonNullable<CoreSessionConfig["hooks"]>["beforeTool"]>;
type BeforeToolCtx = Parameters<BeforeToolFn>[0];
type BeforeToolResult = Awaited<ReturnType<BeforeToolFn>>;

// ===========================================================================
// 1. cloudcode.one inference wiring (ties into the /v1/messages gateway spec)
// ===========================================================================
// NOTE: the @cline/core anthropic provider appends "/messages" (not "/v1/messages") to
// baseUrl, so the base MUST include the /v1 segment or the gateway returns 404 "Not Found".
const CLOUDCODE_BASE_URL = process.env.CLOUDCODE_BASE_URL ?? "https://api.cloudcode.one/v1";
const CLOUDCODE_TOKEN = process.env.CLOUDCODE_TOKEN ?? "";

const KNOWN_MODELS = {
  "deepseek-v4-pro":   { maxTokens: 8192, contextWindow: 128_000, supportsImages: false, inputPrice: 0, outputPrice: 0 },
  "deepseek-v4-flash": { maxTokens: 8192, contextWindow: 128_000, supportsImages: false, inputPrice: 0, outputPrice: 0 },
} as unknown as CoreSessionConfig["knownModels"];

// ===========================================================================
// 2. TOOL APPROVAL
// ---------------------------------------------------------------------------
// Two levers, used together:
//   (a) toolPolicies  — mark which tools require approval (declarative)
//   (b) hooks.beforeTool — the async gate that asks YOUR UI and denies/edits
// ===========================================================================

/** Tools that must not run without explicit user approval. Everything else auto-approves. */
const TOOL_POLICIES: CoreSessionConfig["toolPolicies"] = {
  // key = tool name (e.g. "bash", "editor", "apply-patch") or "*" for all
  bash: { autoApprove: false },
  editor: { autoApprove: false },
  "apply-patch": { autoApprove: false },
  // read-only tools are fine to auto-run (omit them => default enabled + autoApprove)
  // "file-read": { autoApprove: true }, "search": { autoApprove: true },
};

/** Your UI resolves this. Return true to run the tool, false (or a reason) to deny. */
export type ApprovalResolver = (req: {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}) => Promise<{ approved: boolean; reason?: string }>;

/**
 * beforeTool gate. Runs before every tool call. For gated tools it awaits the
 * frontend's decision; you can also bake in hard policy (deny bash matching a
 * denylist without even asking).
 */
function makeApprovalHook(resolve: ApprovalResolver, sessionId: () => string): CoreSessionConfig["hooks"] {
  const beforeTool = async (ctx: BeforeToolCtx): Promise<BeforeToolResult | undefined> => {
    const toolName = ctx.tool?.name ?? ctx.toolCall?.toolName ?? "unknown";

    // Optional hard policy — deny outright, never reaches the user:
    // if (toolName === "bash" && /rm\s+-rf\s+\/(?!\w)/.test(String(ctx.input))) {
    //   return { skip: true, reason: "Blocked: destructive command" };
    // }

    // Only gate the tools we marked autoApprove:false (mirror TOOL_POLICIES):
    const gated = TOOL_POLICIES && toolName in TOOL_POLICIES
      && (TOOL_POLICIES as any)[toolName]?.autoApprove === false;
    if (!gated) return undefined; // let it run

    const decision = await resolve({
      sessionId: sessionId(),
      toolCallId: (ctx.toolCall as any)?.toolCallId ?? "",
      toolName,
      input: ctx.input,
    });
    if (!decision.approved) {
      return { skip: true, reason: decision.reason ?? "Denied by user" };
    }
    return undefined; // approved -> proceed (return { input } here to run an edited input)
  };

  return { beforeTool } as CoreSessionConfig["hooks"];
}

// ===========================================================================
// 3. MCP — two ways to attach servers
// ===========================================================================

/** (A) FILE-BASED (zero extra code at runtime): write the settings file the
 *  runtime auto-loads. Call once at boot / when a user edits their MCP config. */
export async function writeMcpSettings(servers: Record<string, {
  transport:
    | { type: "stdio"; command: string; args?: string[]; cwd?: string; env?: Record<string, string> }
    | { type: "sse"; url: string; headers?: Record<string, string> }
    | { type: "streamableHttp"; url: string; headers?: Record<string, string> };
  disabled?: boolean;
}>, filePath = resolveDefaultMcpSettingsPath()) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ mcpServers: servers }, null, 2), "utf8");
  return filePath;
}
// Example settings the runtime will pick up automatically:
//   await writeMcpSettings({
//     filesystem: { transport: { type: "stdio", command: "npx",
//       args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"] } },
//     docs: { transport: { type: "streamableHttp", url: "https://mcp.example.com",
//       headers: { authorization: `Bearer ${userToken}` } } },
//   });

/** (B) PROGRAMMATIC (fully dynamic, per-user servers with no file). Build a
 *  manager and turn each server into agent tools. Attaching these to a session
 *  goes through the runtime builder (see runtime/orchestration/runtime-builder.ts;
 *  registerMcpServersFromSettingsFile is its file-based counterpart). */
export async function buildMcpTools(registrations: McpServerRegistration[]) {
  const manager = new InMemoryMcpManager({ clientFactory: createDefaultMcpServerClientFactory({}) });
  for (const reg of registrations) await manager.registerServer(reg); // { name, transport, disabled? }
  const tools = await Promise.all(
    registrations.filter(r => !r.disabled).map(r => createMcpTools({ serverName: r.name, provider: manager })),
  );
  return { manager, tools: tools.flat() };
}

// ===========================================================================
// 4. Core (one per host process) + config builder
// ===========================================================================
let corePromise: Promise<ClineCore> | null = null;
const getCore = () => (corePromise ??= ClineCore.create({ clientName: "cloudcode.one" }));

function cloudcodeConfig(opts: {
  cwd: string;
  systemPrompt: string;
  model?: string;
  hooks?: CoreSessionConfig["hooks"];
}): CoreSessionConfig {
  return {
    providerId: "anthropic",
    modelId: opts.model ?? "deepseek-v4-pro",
    apiKey: CLOUDCODE_TOKEN,
    baseUrl: CLOUDCODE_BASE_URL,           // <-- your gateway
    knownModels: KNOWN_MODELS,
    systemPrompt: opts.systemPrompt,
    cwd: opts.cwd,
    mode: "act",
    enableTools: true,
    enableSpawnAgent: false,
    enableAgentTeams: false,
    toolPolicies: TOOL_POLICIES,           // <-- which tools need approval
    hooks: opts.hooks,                     // <-- beforeTool approval gate
  } as CoreSessionConfig;
}

// ===========================================================================
// 5. Run a session: stream events + gate tools through your UI
// ===========================================================================
export interface RunSessionArgs {
  prompt: string;
  cwd: string;
  systemPrompt: string;
  model?: string;
  onEvent: (event: CoreSessionEvent) => void;   // forward to your websocket/SSE
  onApprovalRequest: ApprovalResolver;          // your approve/deny UI resolves this
}

export async function runAgentSession(args: RunSessionArgs) {
  const cline = await getCore();
  let sid = "";
  const hooks = makeApprovalHook(args.onApprovalRequest, () => sid);

  const unsubscribe = cline.subscribe((event: CoreSessionEvent) => args.onEvent(event));
  const { sessionId } = await cline.start({
    config: cloudcodeConfig({ cwd: args.cwd, systemPrompt: args.systemPrompt, model: args.model, hooks }),
    prompt: args.prompt,
    interactive: true,
  });
  sid = sessionId;

  return {
    sessionId,
    // runTurn/send takes a single SendSessionInput object in 0.0.54 (sessionId is a field).
    send: (prompt: string) => cline.send({ sessionId, prompt, mode: "act" }),
    // graceful stop is cline.stop(sessionId) — there is no cline.stopSession() method.
    close: async () => { unsubscribe(); await cline.stop(sessionId); },
  };
}

/*
 * FRONTEND FLOW (approval)
 * ------------------------
 * 1. Session hits a gated tool -> beforeTool calls onApprovalRequest(...) and AWAITS.
 * 2. Your backend forwards { toolCallId, toolName, input } to the browser over your WS.
 * 3. User taps Approve/Deny; the browser sends the decision back.
 * 4. Your backend resolves the pending promise -> beforeTool returns skip (deny) or proceeds.
 * The agent loop is naturally paused on the await; no polling needed.
 *
 * NOTES
 * -----
 * - Auto-approve everything (headless): drop `toolPolicies`/`hooks`, or set toolPolicies { "*": { autoApprove: true } }.
 * - MCP file path is shared per host user by default; for multi-tenant use a per-user
 *   path and point the runtime at it (or use the programmatic path B for isolation).
 * - beforeTool can also enforce silent policy (denylists) without prompting the user.
 * - Verified against @cline/core@0.0.54: ClineCore, InMemoryMcpManager,
 *   createDefaultMcpServerClientFactory, createMcpTools, registerMcpServersFromSettingsFile,
 *   resolveDefaultMcpSettingsPath, CoreSessionConfig, CoreSessionEvent, McpServerRegistration
 *   are all exported from the package root. The beforeTool context/result types are NOT in
 *   @cline/core (they live in @cline/shared) — that's why we derive them from CoreSessionConfig
 *   above. Re-run the smoke test after any version bump; 0.0.x surface can move.
 */
