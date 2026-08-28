import { contextBridge, ipcRenderer } from "electron";
import type { CodePilotAPI } from "./types";

const api: CodePilotAPI = {
  getState: () => ipcRenderer.invoke("state:get"),
  getGlobalSettings: () => ipcRenderer.invoke("settings:get"),
  saveGlobalSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  getProjectBrief: () => ipcRenderer.invoke("project:brief-get"),
  saveProjectBrief: (content) => ipcRenderer.invoke("project:brief-save", content),
  getProjectActivity: () => ipcRenderer.invoke("projects:activity"),
  selectDirectory: (defaultPath) => ipcRenderer.invoke("dialog:directory", defaultPath),
  addProject: (input) => ipcRenderer.invoke("project:add", input),
  switchProject: (id) => ipcRenderer.invoke("project:switch", id),
  openProjectDirectory: () => ipcRenderer.invoke("project:open-directory"),
  getAppStatus: () => ipcRenderer.invoke("app:status"),
  saveAppConfig: (config) => ipcRenderer.invoke("app:save-config", config),
  startProjectApp: () => ipcRenderer.invoke("app:start"),
  stopProjectApp: () => ipcRenderer.invoke("app:stop"),
  openProjectApp: () => ipcRenderer.invoke("app:open"),
  getKnowledge: () => ipcRenderer.invoke("knowledge:get"),
  chatKnowledge: (message) => ipcRenderer.invoke("knowledge:chat", message),
  runAgents: (input) => ipcRenderer.invoke("agents:run", input),
  runAgentBatch: (input) => ipcRenderer.invoke("agents:run-batch", input),
  getActiveAgents: () => ipcRenderer.invoke("agents:active"),
  guideAgent: (taskId, message) => ipcRenderer.invoke("agents:guide", taskId, message),
  interruptAgent: (taskId) => ipcRenderer.invoke("agents:interrupt", taskId),
  getRunDetail: (id) => ipcRenderer.invoke("run:detail", id),
  getPM: () => ipcRenderer.invoke("pm:get"),
  getPMTaskDetail: (id) => ipcRenderer.invoke("pm:task-detail", id),
  chatPM: (message) => ipcRenderer.invoke("pm:chat", message),
  clearPMChat: () => ipcRenderer.invoke("pm:clear-chat"),
  setPMTaskStatus: (id, status, summary) => ipcRenderer.invoke("pm:task-status", id, status, summary),
  recordPMTaskFailure: (id, summary) => ipcRenderer.invoke("pm:task-failure", id, summary),
  onPMUserInputRequired: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("pm:user-input-required", handler);
    return () => ipcRenderer.removeListener("pm:user-input-required", handler);
  },
  createPMTask: (input) => ipcRenderer.invoke("pm:create-task", input),
  commitPMTaskBin: (taskIds) => ipcRenderer.invoke("pm:commit-bin", taskIds),
};
(api as CodePilotAPI & { clearProjectPort: () => Promise<unknown> }).clearProjectPort = () => ipcRenderer.invoke("app:clear-port");
(api as CodePilotAPI & { deletePMTask: (id: string) => Promise<unknown> }).deletePMTask = (id) => ipcRenderer.invoke("pm:delete-task", id);

contextBridge.exposeInMainWorld("codepilot", api);
