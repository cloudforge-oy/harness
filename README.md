# harness

Agent harness on [@cline/core](https://www.npmjs.com/package/@cline/core) talking to the
cloudcode.one `/v1/messages` gateway, plus an Electron desktop app with a Claude-Code-style
chat UI.

## Layout

- `cloudcode-harness.ts` — session wiring: config, tool-approval hook, MCP helpers, `runAgentSession()`
- `cloudcode-smoke.ts` — SDK capability probe + live gateway smoke test
- `app/` — Electron app
  - `main.mjs` — main process; hosts the agent session and bridges it over IPC
  - `portal-auth.mjs` — PKCE loopback flow that fetches the API key from the portal
  - `preload.cjs` — context-isolated bridge (`window.harness`)
  - `renderer/` — chat UI (streaming text, thinking, tool cards, permission prompts,
    image attachments via the composer button or paste)

## Run

```bash
npm install
CLOUDCODE_TOKEN=sk-... npm start
```

Optional env: `CLOUDCODE_BASE_URL` (default `https://api.cloudcode.one/v1`),
`CLOUDCODE_MODEL` (default `deepseek-v4-pro`), `CLOUDCODE_PORTAL_URL`
(default `https://cloudcode.one`).

If `CLOUDCODE_TOKEN` isn't set, the app offers to fetch a key from the portal at
startup (the warning banner reopens the prompt):

1. **Connect with cloudcode.one** (primary) — opens the portal consent page in the
   system browser (PKCE + loopback redirect). After you approve, the app exchanges
   the one-time code for your `sk-…` key and stores it encrypted with Electron's
   `safeStorage` (OS keychain), so it survives restarts. If you deny, or have no
   active key (not subscribed / out of credits), the dialog explains and offers the
   dashboard; authorization codes are single-use and expire after 5 minutes, so a
   retry restarts the flow.
2. **Paste a token manually** — kept in the app's memory for that run only, never
   written to disk.

A `CLOUDCODE_TOKEN` in the environment always wins over a stored key.

Note: if launching from a shell where `ELECTRON_RUN_AS_NODE` is set (e.g. a VS Code
terminal), unset it first: `env -u ELECTRON_RUN_AS_NODE npm start`.

On Ubuntu 23.10+ the first launch may abort with "The SUID sandbox helper binary was
found, but is not configured correctly" (AppArmor restricts unprivileged user
namespaces, and npm can't install Chromium's fallback helper setuid-root). Fix once
per Electron install:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

(or, dev-only: `ELECTRON_DISABLE_SANDBOX=1 npm start`).

## Packaging

```bash
npm run dist:linux   # dist/harness_<version>_amd64.deb
npm run dist:win     # dist/Harness-<version>-win.zip + dist/Harness-Setup-<version>.exe
```

Both first precompile `cloudcode-harness.ts` to plain JS (`npm run build:harness`) so
the packaged app doesn't need tsx/esbuild — esbuild ships platform-specific native
binaries, so bundling it would break cross-platform packaging (a Windows build made
on Linux would carry the Linux binary and fail at runtime). Dev (`npm start`) still
compiles the TS on the fly with tsx.

The Windows NSIS installer is compiled by `scripts/build-win-installer.mjs` from
`build/installer.nsi` using the native (non-wine) makensis that electron-builder
caches under `~/.cache/electron-builder/`, so it builds fine on Linux. It's a
per-user install (no UAC) to `%LOCALAPPDATA%\Programs\Harness` with desktop/start-menu
shortcuts and an Add-or-Remove-Programs entry; the uninstaller is written at install
time on the user's machine (which is why wine isn't needed — electron-builder's own
nsis target pre-generates the uninstaller under wine only so it can code-sign it,
and these builds are unsigned).

## UI development without a token

`HARNESS_DEMO=1 npm start` replays a canned event stream (thinking, streaming text,
a gated `bash` tool call with its permission prompt, markdown, usage) so the renderer
can be exercised offline. `HARNESS_SCREENSHOT=/path.png` captures the window and exits
(`HARNESS_SCREENSHOT_DELAY` in ms, default 1500). The theme follows the system until
the topbar sun/moon button picks one explicitly (persisted in localStorage);
`HARNESS_THEME=dark|light` overrides the system default at launch.

## Lenient tool-argument parsing (postinstall patch)

`@cline/agents` strict-parses the JSON tool arguments streamed from the model and
fails the tool call when they don't parse. Weaker models (deepseek-v4-flash)
routinely emit large `editor` payloads with unescaped quotes/newlines, which made
the editor tool unusable. There's no hook for the raw argument text, so
`scripts/patch-cline-agents.mjs` (run automatically on `npm install`) patches the
parser in `node_modules/@cline/agents` to try [jsonrepair](https://www.npmjs.com/package/jsonrepair)
before giving up. Valid JSON still takes the strict path; unrecoverable garbage
still fails with the original error. The patch is idempotent and aborts the
install loudly if a `@cline` version bump changes the parser (re-verify the
anchor in the script against the new version, then update it).

`scripts/patch-cline-lenient-tools.mjs` and `scripts/patch-cline-thinking.mjs`
(also postinstall) patch `@cline/llms` / `@cline/core` / `ai` the same way — weak-model
tool leniency and the thinking-block round trip described above. Each patch is
idempotent, checks its own anchor, and fails the install loudly on drift.

## GLM thinking (preserved thinking)

GLM reasons on every turn by default, the gateway streams that back as Anthropic
`thinking` blocks, and z.ai's
[preserved thinking](https://docs.z.ai/guides/capabilities/thinking-mode) keeps
the reasoning from earlier assistant turns in the model's context instead of it
being dropped — better continuity in a coding loop, higher cache hits. It works
end to end over `/v1/messages` only if both sides hold up their half.

**Gateway half** (`litellm_hooks.py` / `litellm_config.yaml`, not this repo).
`async_pre_call_deployment_hook` rewrites litellm's internal `thinking_blocks`
into `reasoning_content` — the field the upstreams actually read — and drops any
client-sent `thinking` param, which used to make litellm bridge the call to
`/v1/responses` and 404. The `clear_thinking: false` switch is decisive (0/3 vs
3/3 recall of a fact planted in prior reasoning) and lives per deployment,
because the spelling differs by backend: `thinking: {type: enabled,
clear_thinking: false}` for z.ai, `chat_template_kwargs: {clear_thinking: false}`
for the hosted vLLM on nube.sh, which 400s on z.ai's shape. On the response side
`_ThinkingStreamFixer` repairs the bridged streaming path (it used to hardcode
the first content block to `text` and then pump `thinking_delta`s into it, so a
streamed GLM answer carried no thinking block at all) and signs the blocks;
DeepSeek's own UUID signatures pass through untouched.

**Client half** (this repo). Send the model's own thinking blocks back
unmodified, which needs the block's `signature` to survive the stream — the AI
SDK silently drops any reasoning block it can't attach one to ("unsupported
reasoning metadata"), and `@cline/llms` 0.0.54 loses it in two places.
`scripts/patch-cline-thinking.mjs` (postinstall) fixes that; smoke-test phase 3
asserts turn 2 really put the earlier thinking block on the wire.

The app deliberately sets no `thinking` / `reasoningEffort` /
`thinkingBudgetTokens`: preserved thinking is configured per deployment on the
gateway, and a client-sent `thinking` param is dropped there anyway.

Two consequences worth knowing: reasoning from every prior turn stays in context,
so input token counts grow faster on long GLM conversations; and the rewrite is
`/v1/messages`-only — OpenAI-shape clients still have their reasoning stripped.

## Smoke test

```bash
npm run smoke                      # phase 1: offline SDK surface probe
CLOUDCODE_TOKEN=sk-... npm run smoke   # + phase 2: one live gateway turn
                                       #   phase 3: thinking round trip (GLM)
```

Phase 3 runs two turns on `glm-5.2` (`CLOUDCODE_THINKING_MODEL` overrides) and
inspects the outgoing request bodies: it fails if the model's thinking blocks
didn't make it into turn 2, and skips if the model didn't think that run.

## How the app works

The main process imports `cloudcode-harness.ts` directly (tsx registers a TS loader)
and starts sessions with `runAgentSession()`. Core session events stream to the
renderer over `session:event`; gated tools (`bash`, `editor`, `apply-patch`) block in
the `beforeTool` hook until the user answers the inline permission prompt
(`approval:request` / `approval:respond`). Follow-up prompts go through
`cline.send()` on the same session; the **+** button starts a fresh session.
