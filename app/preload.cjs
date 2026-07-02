// Preload bridge — the only surface the renderer can touch.
const { contextBridge, ipcRenderer } = require("electron");

const subscribe = (channel, cb) => {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("harness", {
  info: () => ipcRenderer.invoke("app:info"),
  pickFolder: () => ipcRenderer.invoke("app:pick-folder"),
  startSession: (args) => ipcRenderer.invoke("session:start", args),
  sendPrompt: (prompt) => ipcRenderer.invoke("session:send", prompt),
  stopSession: () => ipcRenderer.invoke("session:stop"),
  respondApproval: (id, approved, reason) =>
    ipcRenderer.send("approval:respond", { id, approved, reason }),
  onEvent: (cb) => subscribe("session:event", cb),
  onApproval: (cb) => subscribe("approval:request", cb),
});
