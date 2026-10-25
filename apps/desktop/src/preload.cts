import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("xyst", {
  snapshot: () => ipcRenderer.invoke("xyst:snapshot"),
  invoke: (action: string, payload?: unknown) => ipcRenderer.invoke("xyst:invoke", action, payload),
  createMission: (definition: unknown) => ipcRenderer.invoke("xyst:mission-create", definition),
  pickAttachments: () => ipcRenderer.invoke("xyst:pick-attachments") as Promise<string[]>,
  runAgent: (objective: string, attachments: string[] | undefined, runId: string) => ipcRenderer.invoke("xyst:agent-run", objective, attachments, runId),
  resumeSession: (sessionId: string, message: string, attachments: string[] | undefined, runId: string) => ipcRenderer.invoke("xyst:session-resume", sessionId, message, attachments, runId),
  cancelAgent: (runId: string) => ipcRenderer.invoke("xyst:agent-run-cancel", runId),
  sendAgentMessage: (runId: string, content: string) => ipcRenderer.invoke("xyst:agent-message", runId, content),
  openSessionArtifact: (sessionId: string, artifactId: string) => ipcRenderer.invoke("xyst:open-session-artifact", sessionId, artifactId),
  onAgentEvent: (listener: (event: Record<string, unknown>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) => listener(data);
    ipcRenderer.on("xyst:agent-event", handler);
    return () => ipcRenderer.removeListener("xyst:agent-event", handler);
  },
  onUpdaterEvent: (listener: (event: Record<string, unknown>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) => listener(data);
    ipcRenderer.on("xyst:updater-event", handler);
    return () => ipcRenderer.removeListener("xyst:updater-event", handler);
  }
});
