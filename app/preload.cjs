// Preload bridge — the only surface the renderer can touch.
const { contextBridge, ipcRenderer } = require("electron");

const subscribe = (channel, cb) => {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("harness", {
  info: () => ipcRenderer.invoke("app:info"),
  balance: () => ipcRenderer.invoke("app:balance"),
  setToken: (token) => ipcRenderer.invoke("app:set-token", token),
  portalConnect: () => ipcRenderer.invoke("app:portal-connect"),
  portalCancel: () => ipcRenderer.send("app:portal-cancel"),
  openDashboard: () => ipcRenderer.send("app:open-dashboard"),
  pickFolder: () => ipcRenderer.invoke("app:pick-folder"),
  startSession: (args) => ipcRenderer.invoke("session:start", args),
  sendPrompt: (prompt, images) => ipcRenderer.invoke("session:send", { prompt, images }),
  stopSession: () => ipcRenderer.invoke("session:stop"),
  respondApproval: (id, approved, reason) =>
    ipcRenderer.send("approval:respond", { id, approved, reason }),
  onEvent: (cb) => subscribe("session:event", cb),
  onApproval: (cb) => subscribe("approval:request", cb),
});
