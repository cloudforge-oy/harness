/* Harness renderer — consumes CoreSessionEvents from the main process and
 * renders a Claude-Code-style chat: streaming text, thinking, tool cards,
 * and inline permission prompts. */
"use strict";

const chat = document.getElementById("chat");
const emptyState = document.getElementById("empty-state");
const promptInput = document.getElementById("prompt-input");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const statusRow = document.getElementById("status-row");
const statusText = document.getElementById("status-text");
const usageText = document.getElementById("usage-text");
const modelSelect = document.getElementById("model-select");
const cwdChip = document.getElementById("cwd-chip");
const newSessionBtn = document.getElementById("new-session");
const tokenBanner = document.getElementById("token-banner");

const state = {
  cwd: "",
  sessionActive: false,
  busy: false,
  currentText: null,      // { el, mdEl, raw }
  currentThinking: null,  // { el, bodyEl, raw }
  toolCards: new Map(),   // toolCallId -> card refs
  alwaysAllow: new Set(), // tool names auto-approved this session
};

// ---------------------------------------------------------------------------
// tiny markdown renderer (escape first, then transform)
// ---------------------------------------------------------------------------
const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

function renderMarkdown(src) {
  const esc = escapeHtml(src);
  // fenced blocks; an unterminated fence (mid-stream) runs to the end
  const fence = /```\w*\n([\s\S]*?)(?:```|$)/g;
  let html = "", last = 0, m;
  while ((m = fence.exec(esc))) {
    html += mdBlockText(esc.slice(last, m.index));
    html += `<pre><code>${m[1].replace(/\n$/, "")}</code></pre>`;
    last = m.index + m[0].length;
  }
  html += mdBlockText(esc.slice(last));
  return html;
}

function mdBlockText(text) {
  const lines = text.split("\n");
  let html = "", para = [], list = null;
  const flushPara = () => {
    if (para.length) { html += `<p>${inlineMd(para.join("<br>"))}</p>`; para = []; }
  };
  const flushList = () => {
    if (list) { html += `<${list.tag}>${list.items.map((i) => `<li>${inlineMd(i)}</li>`).join("")}</${list.tag}>`; list = null; }
  };
  for (const line of lines) {
    const h = line.match(/^(#{1,3})\s+(.*)/);
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (h) { flushPara(); flushList(); html += `<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`; }
    else if (ul) { flushPara(); if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; } list.items.push(ul[1]); }
    else if (ol) { flushPara(); if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; } list.items.push(ol[1]); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return html;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function addBlock(node) {
  emptyState.classList.add("hidden");
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
  chat.appendChild(node);
  if (nearBottom) chat.scrollTop = chat.scrollHeight;
}

function scrollIfPinned() {
  if (chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120) {
    chat.scrollTop = chat.scrollHeight;
  }
}

const stringify = (v) => {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};

const oneLine = (v, max = 120) => {
  const s = stringify(v).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------
function addUserBlock(text) {
  const block = el("div", "block user");
  const bubble = el("div", "bubble", text);
  block.appendChild(bubble);
  addBlock(block);
}

function ensureTextBlock() {
  if (state.currentText) return state.currentText;
  const block = el("div", "block assistant");
  const md = el("div", "md");
  block.appendChild(md);
  addBlock(block);
  state.currentText = { el: block, mdEl: md, raw: "" };
  return state.currentText;
}

function updateTextBlock(chunk, accumulated) {
  const t = ensureTextBlock();
  t.raw = accumulated !== undefined && accumulated !== null && accumulated !== ""
    ? accumulated
    : t.raw + (chunk ?? "");
  t.mdEl.innerHTML = renderMarkdown(t.raw);
  scrollIfPinned();
}

function endTextBlock(finalText) {
  if (finalText && state.currentText) {
    state.currentText.raw = finalText;
    state.currentText.mdEl.innerHTML = renderMarkdown(finalText);
  }
  state.currentText = null;
}

function ensureThinkingBlock() {
  if (state.currentThinking) return state.currentThinking;
  const details = el("details", "block thinking");
  const summary = el("summary", "", "Thinking…");
  const body = el("div", "thinking-body");
  details.appendChild(summary);
  details.appendChild(body);
  addBlock(details);
  state.currentThinking = { el: details, summaryEl: summary, bodyEl: body, raw: "" };
  return state.currentThinking;
}

function updateThinkingBlock(chunk) {
  const t = ensureThinkingBlock();
  t.raw += chunk ?? "";
  t.bodyEl.textContent = t.raw;
  scrollIfPinned();
}

function endThinkingBlock(finalReasoning) {
  const t = state.currentThinking;
  if (t) {
    if (finalReasoning) t.bodyEl.textContent = t.raw = finalReasoning;
    t.summaryEl.textContent = "Thought for a moment";
  }
  state.currentThinking = null;
}

function addSystemLine(text) {
  addBlock(el("div", "block system", text));
}

function addErrorLine(text) {
  addBlock(el("div", "block error-msg", text));
}

// tool card: "⏺ Bash(command…)" + "⎿ result preview", click to expand
function addToolCard(toolCallId, toolName, input) {
  endTextBlock();
  const block = el("div", "block tool");
  const head = el("div", "tool-head");
  const dot = el("span", "tool-dot running", "⏺");
  const name = el("span", "tool-name", toolName || "tool");
  const summary = el("span", "tool-summary", input !== undefined ? `(${oneLine(input)})` : "");
  head.append(dot, name, summary);

  const resultLine = el("div", "tool-result-line hidden");
  const elbow = el("span", "elbow", "⎿");
  const preview = el("span", "tool-result-preview");
  resultLine.append(elbow, preview);

  const detail = el("div", "tool-detail hidden");
  const inLabel = el("div", "label", "Input");
  const inPre = el("pre", "", stringify(input) || "(none)");
  const outLabel = el("div", "label", "Output");
  const outPre = el("pre", "", "");
  detail.append(inLabel, inPre, outLabel, outPre);

  head.addEventListener("click", () => detail.classList.toggle("hidden"));
  block.append(head, resultLine, detail);
  addBlock(block);

  const card = { block, dot, summary, preview, resultLine, outPre, output: "" };
  if (toolCallId) state.toolCards.set(toolCallId, card);
  return card;
}

function toolCardFor(toolCallId) {
  return toolCallId ? state.toolCards.get(toolCallId) : undefined;
}

function appendToolOutput(card, text) {
  if (!card || !text) return;
  card.output += text;
  card.outPre.textContent = card.output;
  card.resultLine.classList.remove("hidden");
  card.preview.textContent = oneLine(card.output, 140);
  scrollIfPinned();
}

function finishToolCard(card, { output, error, durationMs }) {
  if (!card) return;
  if (output !== undefined && output !== null && output !== "") {
    card.output = stringify(output);
    card.outPre.textContent = card.output;
  }
  card.dot.classList.remove("running");
  if (error) {
    card.dot.classList.add("error");
    card.output = card.output ? `${card.output}\n${error}` : error;
    card.outPre.textContent = card.output;
  } else {
    card.dot.classList.add("done");
  }
  const preview = error ? `Error: ${oneLine(error, 130)}` : oneLine(card.output, 130) || "done";
  const dur = durationMs ? ` (${(durationMs / 1000).toFixed(1)}s)` : "";
  card.preview.textContent = preview + dur;
  card.resultLine.classList.remove("hidden");
  scrollIfPinned();
}

// ---------------------------------------------------------------------------
// permission prompt
// ---------------------------------------------------------------------------
function showApproval(req) {
  if (state.alwaysAllow.has(req.toolName)) {
    window.harness.respondApproval(req.id, true);
    return;
  }
  endTextBlock();
  const block = el("div", "block approval");
  const card = el("div", "card");
  card.appendChild(el("div", "approval-title", "Permission required"));
  card.appendChild(el("div", "approval-tool", `${req.toolName} wants to run:`));
  card.appendChild(el("pre", "", stringify(req.input) || "(no input)"));

  const buttons = el("div", "approval-buttons");
  const yes = el("button", "primary", "Yes");
  const always = el("button", "", `Yes, don’t ask again for ${req.toolName}`);
  const no = el("button", "", "No");
  buttons.append(yes, always, no);
  card.appendChild(buttons);
  block.appendChild(card);
  addBlock(block);
  chat.scrollTop = chat.scrollHeight;

  const resolve = (approved, label) => {
    window.harness.respondApproval(req.id, approved, approved ? undefined : "Denied by user");
    block.innerHTML = "";
    block.appendChild(el("div", "approval-resolved",
      `${approved ? "✓ Approved" : "✗ Denied"} ${req.toolName}${label ? ` — ${label}` : ""}`));
  };
  yes.addEventListener("click", () => resolve(true));
  always.addEventListener("click", () => {
    state.alwaysAllow.add(req.toolName);
    resolve(true, "always this session");
  });
  no.addEventListener("click", () => resolve(false));
}

// ---------------------------------------------------------------------------
// core event stream
// ---------------------------------------------------------------------------
function handleAgentEvent(e) {
  switch (e.type) {
    case "content_start":
      if (e.contentType === "text") updateTextBlock(e.text, e.accumulated);
      else if (e.contentType === "reasoning") updateThinkingBlock(e.reasoning);
      else if (e.contentType === "tool") addToolCard(e.toolCallId, e.toolName, e.input);
      break;
    case "content_update":
      appendToolOutput(toolCardFor(e.toolCallId), stringify(e.update));
      break;
    case "content_end":
      if (e.contentType === "text") endTextBlock(e.text);
      else if (e.contentType === "reasoning") endThinkingBlock(e.reasoning);
      else if (e.contentType === "tool") finishToolCard(toolCardFor(e.toolCallId), e);
      break;
    case "usage":
      usageText.textContent =
        `↑${e.totalInputTokens ?? e.inputTokens ?? 0} ↓${e.totalOutputTokens ?? e.outputTokens ?? 0} tokens` +
        (e.totalCost ? ` · $${e.totalCost.toFixed(4)}` : "");
      setBusy(state.busy); // re-evaluate row visibility
      break;
    case "notice":
      addSystemLine(e.message);
      break;
    case "done":
      endTextBlock(e.text || undefined);
      endThinkingBlock();
      setBusy(false);
      break;
    case "error":
      addErrorLine(String(e.error?.message ?? e.error ?? "Unknown agent error"));
      if (!e.recoverable) setBusy(false);
      break;
    default:
      break; // iteration_start / iteration_end etc.
  }
}

function handleCoreEvent(event) {
  switch (event.type) {
    case "agent_event":
      handleAgentEvent(event.payload.event);
      break;
    case "chunk":
      // "agent" stream duplicates agent_event text; only surface process output
      if (event.payload.stream !== "agent") {
        addSystemLine(`[${event.payload.stream}] ${event.payload.chunk.trim()}`);
      }
      break;
    case "status":
      statusText.textContent = event.payload.status || "Working…";
      break;
    case "ended":
      setBusy(false);
      state.sessionActive = false;
      addSystemLine(`Session ended${event.payload.reason ? ` (${event.payload.reason})` : ""}`);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// composer / session control
// ---------------------------------------------------------------------------
function setBusy(busy) {
  state.busy = busy;
  // keep the row up when idle if there's usage to show
  statusRow.classList.toggle("hidden", !busy && !usageText.textContent);
  statusRow.querySelector(".spinner").classList.toggle("hidden", !busy);
  statusText.classList.toggle("hidden", !busy);
  stopBtn.classList.toggle("hidden", !busy);
  sendBtn.disabled = busy;
  if (busy) statusText.textContent = "Working…";
}

async function submitPrompt() {
  const prompt = promptInput.value.trim();
  if (!prompt || state.busy) return;
  promptInput.value = "";
  autosize();
  addUserBlock(prompt);
  setBusy(true);
  try {
    if (state.sessionActive) {
      await window.harness.sendPrompt(prompt);
    } else {
      state.sessionActive = true;
      await window.harness.startSession({
        prompt,
        cwd: state.cwd,
        model: modelSelect.value,
      });
    }
  } catch (err) {
    state.sessionActive = false;
    setBusy(false);
    addErrorLine(String(err?.message ?? err));
  }
}

async function newSession() {
  await window.harness.stopSession().catch(() => {});
  state.sessionActive = false;
  state.currentText = null;
  state.currentThinking = null;
  state.toolCards.clear();
  state.alwaysAllow.clear();
  setBusy(false);
  usageText.textContent = "";
  chat.querySelectorAll(".block").forEach((b) => b.remove());
  emptyState.classList.remove("hidden");
  promptInput.focus();
}

function autosize() {
  promptInput.style.height = "auto";
  promptInput.style.height = Math.min(promptInput.scrollHeight, 180) + "px";
}

promptInput.addEventListener("input", autosize);
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitPrompt();
  }
});
sendBtn.addEventListener("click", submitPrompt);
newSessionBtn.addEventListener("click", newSession);
stopBtn.addEventListener("click", async () => {
  await window.harness.stopSession().catch(() => {});
  state.sessionActive = false;
  setBusy(false);
  addSystemLine("Interrupted by user");
});
cwdChip.addEventListener("click", async () => {
  const folder = await window.harness.pickFolder();
  if (folder) {
    state.cwd = folder;
    cwdChip.textContent = folder;
    document.getElementById("empty-cwd").textContent = folder;
  }
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
(async () => {
  const info = await window.harness.info();
  state.cwd = info.cwd;
  cwdChip.textContent = info.cwd;
  document.getElementById("empty-cwd").textContent = info.cwd;
  tokenBanner.classList.toggle("hidden", info.hasToken);
  for (const m of info.models) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    if (m === info.defaultModel) opt.selected = true;
    modelSelect.appendChild(opt);
  }
  window.harness.onEvent(handleCoreEvent);
  window.harness.onApproval(showApproval);
  promptInput.focus();
})();
