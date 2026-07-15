/**
 * Electron main process for the Harness desktop app.
 *
 * Hosts the @cline/core agent session (from cloudcode-harness.ts) and bridges
 * it to the renderer:
 *   - session:start / session:send / session:stop   (invoke)
 *   - session:event                                  (main -> renderer stream)
 *   - approval:request / approval:respond            (tool-approval round trip)
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cancelPortalAuth, fetchApiKeyFromPortal } from "./portal-auth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODELS = ["deepseek-v4-pro", "deepseek-v4-flash", "glm-4.7-flash"];
const PORTAL_BASE = (process.env.CLOUDCODE_PORTAL_URL ?? "https://cloudcode.one").replace(/\/+$/, "");
const DEFAULT_SYSTEM_PROMPT =
  "You are Harness, a coding agent running inside a desktop app. " +
  "You operate on the user's working directory with file and shell tools. " +
  "Be direct and concise; use tools when they help.";

let win = null;
let session = null; // { sessionId, send, close } from runAgentSession
let harnessPromise = null;
let approvalSeq = 0;
const pendingApprovals = new Map(); // id -> resolve({ approved, reason })

// A packaged app loads the harness precompiled to plain JS (see
// scripts/build-harness.mjs); dev compiles the TS on the fly with tsx. This
// keeps tsx/esbuild — which ship platform-specific native binaries — out of
// the packaged app, so a build made on one OS runs on another.
const getHarness = () => (harnessPromise ??= loadHarness());

async function loadHarness() {
  const base = path.join(__dirname, "..");
  if (app.isPackaged) {
    return import(pathToFileURL(path.join(base, "cloudcode-harness.js")).href);
  }
  const { register } = await import("tsx/esm/api");
  register();
  return import(pathToFileURL(path.join(base, "cloudcode-harness.ts")).href);
}

const toRenderer = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

function denyAllPending(reason) {
  for (const resolve of pendingApprovals.values()) resolve({ approved: false, reason });
  pendingApprovals.clear();
}

async function closeSession() {
  denyAllPending("Session closed");
  if (!session) return;
  const s = session;
  session = null;
  await s.close().catch(() => {});
}

// ---------------------------------------------------------------------------
// Portal key storage — keys fetched from the portal persist across runs via
// safeStorage (OS keychain backed). Manually pasted tokens are NOT persisted.
// ---------------------------------------------------------------------------
const keyFilePath = () => path.join(app.getPath("userData"), "cloudcode-key.bin");

function loadStoredKey() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(fs.readFileSync(keyFilePath()));
  } catch {
    return null; // no file yet, or keychain unavailable/changed
  }
}

function storeKey(key) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    fs.writeFileSync(keyFilePath(), safeStorage.encryptString(key), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// HARNESS_THEME=dark|light forces the theme (useful with HARNESS_SCREENSHOT).
if (process.env.HARNESS_THEME) nativeTheme.themeSource = process.env.HARNESS_THEME;

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 420,
    minHeight: 400,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff",
    title: "Harness",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("closed", () => { win = null; });

  // UI dev without a gateway token: HARNESS_DEMO=1 replays a canned event stream.
  if (process.env.HARNESS_DEMO) {
    win.webContents.once("did-finish-load", () => replayDemo());
  }

  // Headless UI check: HARNESS_SCREENSHOT=/path.png captures the window and exits.
  if (process.env.HARNESS_SCREENSHOT) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const image = await win.webContents.capturePage();
        const { writeFile } = await import("node:fs/promises");
        await writeFile(process.env.HARNESS_SCREENSHOT, image.toPNG());
        app.quit();
      }, Number(process.env.HARNESS_SCREENSHOT_DELAY ?? 1500));
    });
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle("app:info", () => ({
  cwd: process.cwd(),
  models: MODELS,
  defaultModel: process.env.CLOUDCODE_MODEL ?? MODELS[0],
  baseUrl: process.env.CLOUDCODE_BASE_URL ?? "https://api.cloudcode.one/v1",
  portalBase: PORTAL_BASE,
  hasToken: Boolean(process.env.CLOUDCODE_TOKEN),
  versions: { electron: process.versions.electron, node: process.versions.node },
}));

// Token entered in the UI lives in this process's env only — never written to disk.
ipcMain.handle("app:set-token", (_e, token) => {
  const value = String(token ?? "").trim();
  if (value) process.env.CLOUDCODE_TOKEN = value;
  return { hasToken: Boolean(process.env.CLOUDCODE_TOKEN) };
});

// Browser-based key retrieval; resolves once the user approves in the portal.
// Returns a structured result so the renderer can render each failure mode.
ipcMain.handle("app:portal-connect", async () => {
  try {
    const key = await fetchApiKeyFromPortal({
      portalBase: PORTAL_BASE,
      openExternal: (url) => shell.openExternal(url),
    });
    process.env.CLOUDCODE_TOKEN = key;
    return { ok: true, hasToken: true, stored: storeKey(key) };
  } catch (err) {
    return { ok: false, error: err.code ?? "unknown", message: err.message };
  }
});

ipcMain.on("app:portal-cancel", () => cancelPortalAuth("Cancelled by user"));

ipcMain.on("app:open-dashboard", () => {
  shell.openExternal(`${PORTAL_BASE}/dashboard`);
});

ipcMain.handle("app:pick-folder", async () => {
  const res = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle("session:start", async (_e, args) => {
  await closeSession();
  const harness = await getHarness();
  session = await harness.runAgentSession({
    prompt: args.prompt,
    images: args.images,
    cwd: args.cwd || process.cwd(),
    model: args.model,
    systemPrompt: args.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    onEvent: (event) => toRenderer("session:event", event),
    onApprovalRequest: (req) =>
      new Promise((resolve) => {
        const id = `approval-${++approvalSeq}`;
        pendingApprovals.set(id, resolve);
        toRenderer("approval:request", { id, ...req });
      }),
  });
  return { sessionId: session.sessionId };
});

ipcMain.handle("session:send", async (_e, { prompt, images }) => {
  if (!session) throw new Error("No active session");
  await session.send(prompt, images);
  return { sessionId: session.sessionId };
});

ipcMain.handle("session:stop", async () => {
  await closeSession();
  return { ok: true };
});

ipcMain.on("approval:respond", (_e, { id, approved, reason }) => {
  const resolve = pendingApprovals.get(id);
  if (!resolve) return;
  pendingApprovals.delete(id);
  resolve({ approved, reason });
});

// ---------------------------------------------------------------------------
// Demo stream — synthetic CoreSessionEvents so the UI can be exercised
// without a gateway token (HARNESS_DEMO=1).
// ---------------------------------------------------------------------------
async function replayDemo() {
  const sessionId = "demo";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const agent = (event) => toRenderer("session:event", { type: "agent_event", payload: { sessionId, event } });

  await sleep(300);
  agent({ type: "content_start", contentType: "reasoning", reasoning: "The user wants a directory listing — I should run ls." });
  await sleep(250);
  agent({ type: "content_end", contentType: "reasoning" });
  agent({ type: "content_start", contentType: "text", text: "I'll list the project files first.", accumulated: "I'll list the project files first." });
  await sleep(250);
  agent({ type: "content_end", contentType: "text", text: "I'll list the project files first." });
  agent({ type: "content_start", contentType: "tool", toolName: "bash", toolCallId: "t1", input: { command: "ls -la" } });
  await sleep(250);
  toRenderer("approval:request", { id: "demo-approval", sessionId, toolCallId: "t1", toolName: "bash", input: { command: "ls -la" } });
  await sleep(600);
  agent({ type: "content_end", contentType: "tool", toolName: "bash", toolCallId: "t1", output: "app/  cloudcode-harness.ts  cloudcode-smoke.ts  package.json", durationMs: 412 });
  await sleep(250);
  const md = "Here's the repo layout:\n\n- `app/` — the Electron UI\n- `cloudcode-harness.ts` — agent session wiring\n\n```bash\nnpm start\n```";
  agent({ type: "content_start", contentType: "text", text: md, accumulated: md });
  agent({ type: "content_end", contentType: "text", text: md });
  agent({ type: "usage", inputTokens: 812, outputTokens: 164, totalInputTokens: 812, totalOutputTokens: 164, totalCost: 0.0042 });
  agent({ type: "done", reason: "completed", text: md, iterations: 2 });
}

// ---------------------------------------------------------------------------
// NOTE: must stay a .then() chain — Electron emits "ready" only after the main
// module finishes evaluating, so a top-level `await app.whenReady()` deadlocks.
app.whenReady().then(() => {
  // safeStorage needs the app to be ready; env still wins over the stored key.
  if (!process.env.CLOUDCODE_TOKEN) {
    const stored = loadStoredKey();
    if (stored) process.env.CLOUDCODE_TOKEN = stored;
  }
  createWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  denyAllPending("App quitting");
  cancelPortalAuth("App quitting");
  if (session) session.close().catch(() => {});
});
