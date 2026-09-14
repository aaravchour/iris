// Hermes Deck preload — thin context bridge (iris preload.cjs pattern).
// The only fs-adjacent surface is readFileTail, which the main process
// validates hard (delegation live dir + task-N.log naming) before touching
// the filesystem. No arbitrary fs, no remote content.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deck", {
  getFeed: () => ipcRenderer.invoke("deck:read-feed"),
  getHeartbeatAge: () => ipcRenderer.invoke("deck:heartbeat-age"),
  onFeed: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("deck:feed", handler);
    return () => ipcRenderer.removeListener("deck:feed", handler);
  },
  touchHeartbeat: () => ipcRenderer.send("deck:heartbeat"),
  toggleVisibility: () => ipcRenderer.send("deck:toggle-visibility"),
  // Safe tail of a delegation transcript: main validates the path starts
  // with ~/.hermes/cache/delegation/live/ and the basename is task-N.log.
  readFileTail: (logPath, maxLines) =>
    ipcRenderer.invoke("deck:read-log-tail", logPath, maxLines),
  resolveLog: (delegationIdOrPath) =>
    ipcRenderer.invoke("deck:resolve-log", delegationIdOrPath),
});