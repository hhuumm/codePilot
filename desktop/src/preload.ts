import { contextBridge, ipcRenderer } from "electron";
import type { CodePilotAPI } from "./types";

const api: CodePilotAPI = {
  getState: () => ipcRenderer.invoke("state:get"),
  getGlobalSettings: () => ipcRenderer.invoke("settings:get"),
  saveGlobalSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  getProjectBrief: (projectId) => ipcRenderer.invoke("project:brief-get", projectId),
  saveProjectBrief: (projectId, content) => ipcRenderer.invoke("project:brief-save", projectId, content),
  getProjectActivity: () => ipcRenderer.invoke("projects:activity"),
  selectDirectory: (defaultPath) => ipcRenderer.invoke("dialog:directory", defaultPath),
  addProject: (input) => ipcRenderer.invoke("project:add", input),
  onboardProject: (input) => ipcRenderer.invoke("project:onboard", input),
  switchProject: (id) => ipcRenderer.invoke("project:switch", id),
  openProjectDirectory: (projectId) => ipcRenderer.invoke("project:open-directory", projectId),
  getAppStatus: (projectId) => ipcRenderer.invoke("app:status", projectId),
  saveAppConfig: (projectId, config) => ipcRenderer.invoke("app:save-config", projectId, config),
  startProjectApp: (projectId) => ipcRenderer.invoke("app:start", projectId),
  stopProjectApp: (projectId) => ipcRenderer.invoke("app:stop", projectId),
  clearProjectPort: (projectId) => ipcRenderer.invoke("app:clear-port", projectId),
  openProjectApp: (projectId) => ipcRenderer.invoke("app:open", projectId),
  getKnowledge: (projectId) => ipcRenderer.invoke("knowledge:get", projectId),
  chatKnowledge: (projectId, message) => ipcRenderer.invoke("knowledge:chat", projectId, message),
  runAgents: (input) => ipcRenderer.invoke("agents:run", input),
  runAgentBatch: (input) => ipcRenderer.invoke("agents:run-batch", input),
  getActiveAgents: (projectId) => ipcRenderer.invoke("agents:active", projectId),
  guideAgent: (projectId, taskId, message) => ipcRenderer.invoke("agents:guide", projectId, taskId, message),
  interruptAgent: (projectId, taskId) => ipcRenderer.invoke("agents:interrupt", projectId, taskId),
  getRunDetail: (projectId, id) => ipcRenderer.invoke("run:detail", projectId, id),
  getPM: (projectId) => ipcRenderer.invoke("pm:get", projectId),
  getPMTaskDetail: (projectId, id) => ipcRenderer.invoke("pm:task-detail", projectId, id),
  chatPM: (projectId, message) => ipcRenderer.invoke("pm:chat", projectId, message),
  clearPMChat: (projectId) => ipcRenderer.invoke("pm:clear-chat", projectId),
  setPMTaskStatus: (projectId, id, status, summary) => ipcRenderer.invoke("pm:task-status", projectId, id, status, summary),
  recordPMTaskFailure: (projectId, id, summary) => ipcRenderer.invoke("pm:task-failure", projectId, id, summary),
  onPMUserInputRequired: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, projectId: string) => listener(projectId);
    ipcRenderer.on("pm:user-input-required", handler);
    return () => ipcRenderer.removeListener("pm:user-input-required", handler);
  },
  createPMTask: (projectId, input) => ipcRenderer.invoke("pm:create-task", projectId, input),
  commitPMTaskBin: (projectId, taskIds) => ipcRenderer.invoke("pm:commit-bin", projectId, taskIds),
  deletePMTask: (projectId, id) => ipcRenderer.invoke("pm:delete-task", projectId, id),
};

contextBridge.exposeInMainWorld("codepilot", api);
