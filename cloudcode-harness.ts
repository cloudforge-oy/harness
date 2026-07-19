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
 * Tool approval levers (both required together for interactive approval):
 *   config.toolPolicies?: Record<string,{ enabled?; autoApprove? }>   // "*" = wildcard
 *   start({ capabilities: { requestToolApproval } })  // the async gate core awaits
 * NOTE: hooks.beforeTool is NOT an approval mechanism — the runtime enforces
 * toolPolicies AFTER hooks run, and a gated tool fails with "requires approval
 * but no approval callback is configured" unless requestToolApproval is set.
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
  ToolApprovalRequest,
  ToolApprovalResult,
} from "@cline/core";

// ===========================================================================
// 1. cloudcode.one inference wiring (ties into the /v1/messages gateway spec)
// ===========================================================================
// NOTE: the @cline/core anthropic provider appends "/messages" (not "/v1/messages") to
// baseUrl, so the base MUST include the /v1 segment or the gateway returns 404 "Not Found".
// Read lazily (not at module load) so a host app can set the token after import.
const cloudcodeBaseUrl = () => process.env.CLOUDCODE_BASE_URL ?? "https://api.cloudcode.one/v1";
const cloudcodeToken = () => process.env.CLOUDCODE_TOKEN ?? "";

/** One entry of https://cloudcode.one/models.json (prices are USD per 1M tokens). */
export interface CloudcodeModel {
  id: string;
  blurb?: string;
  input: number;
  output: number;
  cached_input?: number | null;
  free?: boolean;
  vision?: boolean;
}

// max_tokens 32768 verified accepted by the gateway; 8192 truncated large
// tool calls (a 48k-char editor write is ~12k tokens) mid-JSON, which surfaced
// as unparseable/empty tool arguments from weak models.
const MODEL_MAX_TOKENS = 32_768;

const FALLBACK_KNOWN_MODELS = {
  "deepseek-v4-pro":   { maxTokens: MODEL_MAX_TOKENS, contextWindow: 128_000, supportsImages: true, inputPrice: 0, outputPrice: 0 },
  "deepseek-v4-flash": { maxTokens: MODEL_MAX_TOKENS, contextWindow: 128_000, supportsImages: true, inputPrice: 0, outputPrice: 0 },
} as unknown as CoreSessionConfig["knownModels"];

/** Catalog entries -> core ModelInfo, so core's usage events carry a real
 *  totalCost. supportsImages stays true even for vision:false models — the
 *  gateway accepts images on any model and reroutes them to a vision variant;
 *  the vision flag is a UI concern. */
function toKnownModels(models?: CloudcodeModel[]): CoreSessionConfig["knownModels"] {
  if (!models?.length) return FALLBACK_KNOWN_MODELS;
  const known: Record<string, unknown> = {};
  for (const m of models) {
    known[m.id] = {
      maxTokens: MODEL_MAX_TOKENS,
      contextWindow: 128_000,
      supportsImages: true,
      supportsPromptCache: m.cached_input != null,
      inputPrice: m.input,
      outputPrice: m.output,
      ...(m.cached_input != null ? { cacheReadsPrice: m.cached_input } : {}),
    };
  }
  return known as unknown as CoreSessionConfig["knownModels"];
}

// ===========================================================================
// 2. TOOL APPROVAL
// ---------------------------------------------------------------------------
// Two levers, used together:
//   (a) toolPolicies — mark which tools require approval (declarative)
//   (b) capabilities.requestToolApproval — the async gate core awaits for every
//       autoApprove:false tool call; without it those calls FAIL with
//       "requires approval but no approval callback is configured"
// ===========================================================================

/** Tools that must not run without explicit user approval. Everything else
 *  auto-approves. Names must match the runtime's registered tools exactly
 *  (see name:"..." in @cline/core dist): run_commands / editor / apply_patch. */
const TOOL_POLICIES: CoreSessionConfig["toolPolicies"] = {
  run_commands: { autoApprove: false },
  editor: { autoApprove: false },
  apply_patch: { autoApprove: false },
  // read-only tools are fine to auto-run (omit them => default enabled + autoApprove)
  // read_files / search_codebase / fetch_web_content
};

/** Your UI resolves this. Return true to run the tool, false (or a reason) to deny. */
export type ApprovalResolver = (req: {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}) => Promise<{ approved: boolean; reason?: string }>;

/**
 * Adapts our UI resolver to core's requestToolApproval capability. Core calls
 * this for every autoApprove:false tool call and awaits the decision; the
 * agent loop is naturally paused on the await. You can also bake in hard
 * policy here (deny a command matching a denylist without even asking).
 */
function makeApprovalCapability(resolve: ApprovalResolver) {
  return async (req: ToolApprovalRequest): Promise<ToolApprovalResult> => {
    // Optional hard policy — deny outright, never reaches the user:
    // if (req.toolName === "run_commands" && /rm\s+-rf\s+\/(?!\w)/.test(String(req.input))) {
    //   return { approved: false, reason: "Blocked: destructive command" };
    // }
    const decision = await resolve({
      sessionId: req.sessionId,
      toolCallId: req.toolCallId,
      toolName: req.toolName,
      input: req.input,
    });
    return { approved: decision.approved, reason: decision.reason };
  };
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
  models?: CloudcodeModel[];
}): CoreSessionConfig {
  return {
    providerId: "anthropic",
    modelId: opts.model ?? "deepseek-v4-pro",
    apiKey: cloudcodeToken(),
    baseUrl: cloudcodeBaseUrl(),           // <-- your gateway
    knownModels: toKnownModels(opts.models),
    // Without this the provider requests max_tokens=4096 (knownModels alone
    // doesn't raise it — core plumbs maxTokensPerTurn into the request),
    // truncating large tool calls mid-JSON — the source of "invalid JSON
    // arguments" / empty-input tool calls from weak models.
    maxTokensPerTurn: MODEL_MAX_TOKENS,
    systemPrompt: opts.systemPrompt,
    cwd: opts.cwd,
    mode: "act",
    enableTools: true,
    enableSpawnAgent: false,
    enableAgentTeams: false,
    toolPolicies: TOOL_POLICIES,           // <-- which tools need approval
  } as CoreSessionConfig;
}

// ===========================================================================
// 5. Run a session: stream events + gate tools through your UI
// ===========================================================================
export interface RunSessionArgs {
  prompt: string;
  /** Image attachments as data URLs ("data:image/png;base64,..."); the runtime
   *  parses them into image content blocks (raw strings are assumed base64 PNG). */
  images?: string[];
  cwd: string;
  systemPrompt: string;
  model?: string;
  /** Model catalog fetched from https://cloudcode.one/models.json; feeds
   *  knownModels so core prices usage events. Omitted -> fallback entries. */
  models?: CloudcodeModel[];
  onEvent: (event: CoreSessionEvent) => void;   // forward to your websocket/SSE
  onApprovalRequest: ApprovalResolver;          // your approve/deny UI resolves this
}

export async function runAgentSession(args: RunSessionArgs) {
  const cline = await getCore();

  const unsubscribe = cline.subscribe((event: CoreSessionEvent) => args.onEvent(event));
  const { sessionId } = await cline.start({
    config: cloudcodeConfig({ cwd: args.cwd, systemPrompt: args.systemPrompt, model: args.model, models: args.models }),
    prompt: args.prompt,
    userImages: args.images,
    interactive: true,
    // Client-owned capability core awaits for every toolPolicies-gated call.
    capabilities: { requestToolApproval: makeApprovalCapability(args.onApprovalRequest) },
  });

  return {
    sessionId,
    // runTurn/send takes a single SendSessionInput object in 0.0.54 (sessionId is a field).
    send: (prompt: string, images?: string[]) =>
      cline.send({ sessionId, prompt, mode: "act", userImages: images }),
    // graceful stop is cline.stop(sessionId) — there is no cline.stopSession() method.
    close: async () => { unsubscribe(); await cline.stop(sessionId); },
  };
}

/*
 * FRONTEND FLOW (approval)
 * ------------------------
 * 1. Session hits a toolPolicies-gated tool -> core calls requestToolApproval(...) and AWAITS.
 * 2. Your backend forwards { toolCallId, toolName, input } to the browser over your WS.
 * 3. User taps Approve/Deny; the browser sends the decision back.
 * 4. Your backend resolves the pending promise -> core runs the tool or skips it with the reason.
 * The agent loop is naturally paused on the await; no polling needed.
 *
 * NOTES
 * -----
 * - Auto-approve everything (headless): drop `toolPolicies` (and the capability),
 *   or set toolPolicies { "*": { autoApprove: true } }.
 * - MCP file path is shared per host user by default; for multi-tenant use a per-user
 *   path and point the runtime at it (or use the programmatic path B for isolation).
 * - requestToolApproval can also enforce silent policy (denylists) without prompting.
 * - Verified against @cline/core@0.0.54: ClineCore, InMemoryMcpManager,
 *   createDefaultMcpServerClientFactory, createMcpTools, registerMcpServersFromSettingsFile,
 *   resolveDefaultMcpSettingsPath, CoreSessionConfig, CoreSessionEvent, McpServerRegistration,
 *   ToolApprovalRequest, ToolApprovalResult are all exported from the package root.
 *   Tool names in toolPolicies must match the runtime's registered tools
 *   (run_commands / editor / apply_patch / read_files / search_codebase / ...).
 *   Re-run the smoke test after any version bump; 0.0.x surface can move.
 */
