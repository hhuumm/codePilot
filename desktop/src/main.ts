import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import started from "electron-squirrel-startup";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ChatMessage,
  AppConfig,
  DesktopState,
  KnowledgeEntry,
  KnowledgeState,
  GlobalSettings,
  PMState,
  PMTask,
  NewPMTask,
  TaskBin,
  Project,
  ProjectOnboardingInput,
} from "./types";
import { Manager } from "../../src/manager";
import type { ProviderName } from "../../src/domain";
import type { AgentBatchRunInput, AgentRunInput } from "./types";
import { interruptAgent, pendingAgentGuidance, queueAgentGuidance } from "../../src/control";
import { isolatedAgentEnvironment } from "../../src/providers/process";
import {
  assertTaskLaunchable,
  cycleTasksOut,
  omitTaskDependencies,
  reconcileTaskStatuses,
  topologicallySortTasks,
  validateTaskGraph,
} from "../../src/pm-graph";
import {
  loadPMTaskBins,
  loadPMTasks,
  saveCommittedTaskBin,
  savePMTasks,
} from "../../src/pm-store";
import { CodexAppServer } from "./codex-app-server";
import { KeyedSerialQueue } from "../../src/keyed-queue";
import {
  canonicalGitRepository,
  cloneGitRepository,
  repositoryNameFromRemote,
  suggestedProjectName,
} from "../../src/project-onboarding";
import { removeProjectRegistration } from "../../src/project-registry";
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;
if (started) app.quit();
let window: BrowserWindow | null = null;
const pmServer = new CodexAppServer();
const pmThreads = new Map<string, string>();
const pmTurns = new KeyedSerialQueue();
const pmActivity = new Map<string, number>();
const appProcesses = new Map<string, ReturnType<typeof spawn>>();
const appProcessState = new Map<string, { startedAt?: string; logs: string[] }>();
const defaultGlobalSettings: GlobalSettings = { defaultProvider: "codex", scaffold: { mode: "guided", autoDeploy: false, onboardingPrompt: "You are onboarding me into a new project. Begin by asking focused questions about the users, problem, core workflow, constraints, technology preferences, and definition of success. Summarize decisions as we go. Create small implementation tasks only after requirements are agreed, then continue helping me shape and build the project incrementally." } };
const file = () => join(app.getPath("userData"), "state.json");
function load(): DesktopState {
  try {
    return JSON.parse(readFileSync(file(), "utf8")) as DesktopState;
  } catch {
    const repo = resolve(process.env.CODEPILOT_REPO || process.cwd()),
      project = {
        id: randomUUID(),
        name: repo.split(/[\\/]/).pop() || "Project",
        repo,
        createdAt: new Date().toISOString(),
      };
    return {
      projects: [project],
      activeProjectId: project.id,
      projectsDirectory: dirname(repo),
      globalSettings: defaultGlobalSettings,
      runs: [],
    };
  }
}
function save(state: DesktopState) {
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(state, null, 2));
}
function hydrate() {
  const state = load();
  state.globalSettings = { ...defaultGlobalSettings, ...state.globalSettings, scaffold: { ...defaultGlobalSettings.scaffold, ...state.globalSettings?.scaffold } };
  const
    project =
      state.projects.find((item) => item.id === state.activeProjectId) ??
      state.projects[0];
  state.runs = [];
  if (project) {
    const db = join(project.repo, ".codepilot", "codepilot.db");
    if (existsSync(db)) {
      using database = new DatabaseSync(db, { readOnly: true });
      state.runs = (
        database
          .prepare(
            "SELECT id, objective, status, created_at FROM runs ORDER BY created_at DESC",
          )
          .all() as Array<Record<string, unknown>>
      ).map((row) => ({
        id: String(row.id),
        objective: String(row.objective),
        status: String(row.status),
        createdAt: String(row.created_at),
      }));
    }
  }
  return state;
}
function recoverInterruptedRuns() {
  for (const project of load().projects) {
    const db = join(project.repo, ".codepilot", "codepilot.db");
    if (!existsSync(db)) continue;
    try {
      using database = new DatabaseSync(db);
      const now = new Date().toISOString();
      database
        .prepare(
          "UPDATE tasks SET status = 'failed', updated_at = ? WHERE status IN ('leased','running','validating')",
        )
        .run(now);
      database
        .prepare(
          "UPDATE runs SET status = 'needs_review', updated_at = ? WHERE status = 'running'",
        )
        .run(now);
    } catch {
      /* A damaged or locked project database should not prevent startup. */
    }
  }
}
function runDetail(project: Project, id: string) {
  const db = join(project.repo, ".codepilot", "codepilot.db");
  if (!existsSync(db)) throw new Error("Run database not found");
  using database = new DatabaseSync(db, { readOnly: true });
  const run = database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!run) throw new Error("Run not found");
  const tasks = database
    .prepare(
      "SELECT id, provider, status FROM tasks WHERE run_id = ? ORDER BY created_at",
    )
    .all(id) as Array<Record<string, unknown>>;
  return {
    id: String(run.id),
    objective: String(run.objective),
    status: String(run.status),
    createdAt: String(run.created_at),
    updatedAt: String(run.updated_at),
    ...(run.summary
      ? { summary: JSON.parse(String(run.summary)) as unknown }
      : {}),
    workers: tasks.map((task) => {
      const result = database
        .prepare("SELECT result FROM worker_results WHERE task_id = ?")
        .get(String(task.id)) as Record<string, unknown> | undefined;
      const parsed = result
        ? (JSON.parse(String(result.result)) as Record<string, unknown>)
        : undefined;
      return {
        taskId: String(task.id),
        provider: String(task.provider),
        status: String(task.status),
        ...(parsed?.report ? { report: parsed.report } : {}),
        ...(parsed?.verification ? { verification: parsed.verification } : {}),
        warnings: Array.isArray(parsed?.warnings) ? parsed.warnings : [],
      };
    }),
  };
}
function registerIPC() {
  ipcMain.handle("state:get", () => hydrate());
  ipcMain.handle("project:brief-get",(_event,projectId:string)=>projectBrief(projectById(projectId)));
  ipcMain.handle("project:brief-save",(_event,projectId:string,content:string)=>saveProjectBrief(projectById(projectId),String(content).slice(0,100000)));
  ipcMain.handle("projects:activity",()=>projectActivity());
  ipcMain.handle("settings:get", () => ({ ...defaultGlobalSettings, ...load().globalSettings, scaffold: { ...defaultGlobalSettings.scaffold, ...load().globalSettings?.scaffold } }));
  ipcMain.handle("settings:save", (_event, settings: GlobalSettings) => {
    const state = load();
    state.globalSettings = { defaultProvider: settings.defaultProvider === "claude" ? "claude" : "codex", scaffold: { mode: settings.scaffold?.mode === "blank" ? "blank" : "guided", autoDeploy: Boolean(settings.scaffold?.autoDeploy), onboardingPrompt: String(settings.scaffold?.onboardingPrompt || defaultGlobalSettings.scaffold.onboardingPrompt).trim().slice(0, 12000) } };
    save(state); return state.globalSettings;
  });
  ipcMain.handle("run:detail", (_event, projectId: string, id: string) => runDetail(projectById(projectId), id));
  ipcMain.handle("app:status", (_event, projectId: string) => projectAppStatus(projectById(projectId)));
  ipcMain.handle("app:save-config", (_event, projectId: string, config: AppConfig) => {
    const project = projectById(projectId);
    saveAppConfig(config, project);
    return projectAppStatus(project);
  });
  ipcMain.handle("app:start", (_event, projectId: string) => startProjectApp(projectById(projectId)));
  ipcMain.handle("app:stop", (_event, projectId: string) => stopProjectApp(projectById(projectId)));
  ipcMain.handle("app:clear-port", (_event, projectId: string) => clearProjectPort(projectById(projectId)));
  ipcMain.handle("app:open", async (_event, projectId: string) => {
    const { config } = projectAppStatus(projectById(projectId));
    if (!/^https?:\/\//i.test(config.url)) throw new Error("Configure an http:// or https:// app URL first");
    await shell.openExternal(config.url);
  });
  ipcMain.handle("dialog:directory", async (_event, defaultPath?: string) => {
    const result = await dialog.showOpenDialog(window!, {
      title: "Choose a codePilot directory",
      defaultPath,
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle("project:switch", (_event, id: string) => {
    const state = load();
    if (state.projects.some((project) => project.id === id)) {
      state.activeProjectId = id;
      save(state);
    }
    return hydrate();
  });
  ipcMain.handle(
    "project:add",
    (_event, input: { name: string }) => {
      const state = load(),
        name = input.name.trim();
      if (!name) throw new Error("Project name is required");
      const repo = resolve(state.projectsDirectory, name.replace(/[^a-zA-Z0-9._-]+/g, "-"));
      const rel = relative(resolve(state.projectsDirectory), repo);
      if (!rel || rel.startsWith("..")) throw new Error("Invalid generated project path");
      if (existsSync(repo)) throw new Error("Project directory already exists");
      ensureProjectGit(repo, true);
      execFileSync("git", ["-C", repo, "-c", "user.name=codePilot", "-c", "user.email=codepilot@local", "commit", "--allow-empty", "-m", "Initialize project"]);
      const project: Project = {
        id: randomUUID(),
        name,
        repo,
        createdAt: new Date().toISOString(),
      };
      state.projects.push(project);
      state.activeProjectId = project.id;
      save(state);
      return hydrate();
    },
  );
  ipcMain.handle("project:onboard", async (_event, input: ProjectOnboardingInput) => {
    const state = load();
    const repo = input.source === "local"
      ? canonicalGitRepository(input.repo)
      : await cloneGitRepository({
          url: input.url,
          projectsDirectory: state.projectsDirectory,
          ...(input.directoryName?.trim() ? { directoryName: input.directoryName } : {}),
        });
    ensureProjectGit(repo);
    const existing = state.projects.find((project) => samePath(project.repo, repo));
    const fallbackName = input.source === "local" ? suggestedProjectName(repo) : repositoryNameFromRemote(input.url);
    const name = input.name?.trim() || fallbackName;
    const project: Project = existing ?? { id: randomUUID(), name, repo, createdAt: new Date().toISOString() };
    if (!existing) state.projects.push(project);
    state.activeProjectId = project.id;
    save(state);
    return hydrate();
  });
  ipcMain.handle("project:remove", (_event, projectId: string) => {
    const state = load();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("Project not found. Refresh the workspace and try again.");
    const activity = projectActivity()[project.id] ?? 0;
    const appProcess = appProcesses.get(project.id);
    if (activity > 0 || appProcess?.exitCode === null)
      throw new Error("Stop this project's PM, agents, and app process before removing it.");
    const next = removeProjectRegistration(state.projects, state.activeProjectId, project.id);
    state.projects = next.projects;
    state.activeProjectId = next.activeProjectId;
    state.runs = [];
    pmThreads.delete(project.id);
    appProcessState.delete(project.id);
    save(state);
    return hydrate();
  });
}
function activeAgents(project: Project) {
  const db = join(project.repo, ".codepilot", "codepilot.db");
  if (!existsSync(db)) return [];
  using database = new DatabaseSync(db, { readOnly: true });
  const tasks = database
    .prepare(
      "SELECT id, run_id, provider, status, objective, updated_at FROM tasks WHERE status IN ('leased','running') ORDER BY updated_at DESC",
    )
    .all() as Array<Record<string, unknown>>;
  return tasks.map((task) => {
    const events = database
      .prepare(
        "SELECT timestamp, stream, payload FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 40",
      )
      .all(String(task.id)) as Array<Record<string, unknown>>;
    return {
      projectId: project.id,
      taskId: String(task.id),
      runId: String(task.run_id),
      provider: String(task.provider),
      status: String(task.status),
      objective: String(task.objective).split("\n\nRepository context")[0],
      updatedAt: String(task.updated_at),
      pendingGuidance: pendingAgentGuidance(String(task.id)),
      events: events.reverse().map((event) => ({
        timestamp: String(event.timestamp),
        stream: String(event.stream),
        payload: JSON.parse(String(event.payload)) as unknown,
      })),
    };
  });
}
function registerAgentIPC() {
  ipcMain.handle("agents:active", (_event, projectId: string) => activeAgents(projectById(projectId)));
  ipcMain.handle("agents:guide", (_event, projectId: string, taskId: string, message: string) => {
    const project = projectById(projectId);
    if (!activeAgents(project).some((agent) => agent.taskId === taskId))
      throw new Error("That agent is no longer active");
    queueAgentGuidance(taskId, message.slice(0, 4000));
    return activeAgents(project);
  });
  ipcMain.handle("agents:interrupt", (_event, projectId: string, taskId: string) => {
    const project = projectById(projectId);
    if (!activeAgents(project).some((agent) => agent.taskId === taskId))
      throw new Error("That agent is no longer active");
    if (!interruptAgent(taskId)) throw new Error("That agent is no longer interruptible");
    return {
      feedback: "Interrupt received. I’m stopping safely now; completed changes and the available handoff evidence will be preserved in session history.",
      agents: activeAgents(project),
    };
  });
  ipcMain.handle("project:open-directory", async (_event, projectId: string) => {
    const error = await shell.openPath(projectById(projectId).repo);
    if (error) throw new Error(error);
  });
  ipcMain.handle("agents:run", async (_event, input: AgentRunInput) => {
    const project = projectById(input.projectId);
    if (typeof project.repo !== "string" || !project.repo.trim()) throw new Error("The selected project has no repository path. Re-select the project or add it again before deploying an agent.");
    const
      objective = input.objective.trim(),
      providers = input.providers.filter(
        (name): name is ProviderName => name === "codex" || name === "claude",
      );
    if (!objective) throw new Error("Describe what the agents should do");
    if (!providers.length) throw new Error("Select at least one agent");
    const retries = Math.max(0, Math.min(3, Math.trunc(input.retries || 0))),
      timeoutMinutes = Math.max(
        1,
        Math.min(180, Math.trunc(input.timeoutMinutes || 30)),
      ),
      validationCommands = input.validationCommands
        .map((command) => command.trim())
        .filter(Boolean)
        .slice(0, 10);
    const summary = await new Manager().run({
      objective,
      repo: project.repo,
      providers,
      dryRun: Boolean(input.dryRun),
      retries,
      timeoutMs: timeoutMinutes * 60_000,
      integrate: Boolean(input.integrate),
      createPullRequest: Boolean(input.createPullRequest),
      ...(validationCommands.length ? { validationCommands } : {}),
    });
    return {
      runId: summary.runId,
      status: summary.status,
      ...(summary.integrationBranch
        ? { integrationBranch: summary.integrationBranch }
        : {}),
      ...(summary.pullRequestUrl ? { pullRequestUrl: summary.pullRequestUrl } : {}),
      review: summary.review,
    };
  });
  ipcMain.handle("agents:run-batch", async (_event, input: AgentBatchRunInput) => {
    const project = projectById(input.projectId);
    if (!project.repo?.trim()) throw new Error("The selected project has no repository path.");
    const items = input.items.slice(0, 20).map((item) => ({
      id: item.id.trim(),
      objective: item.objective.trim(),
      provider: item.provider,
    }));
    if (!items.length || items.some((item) => !item.id || !item.objective))
      throw new Error("Every batch item needs an id and objective");
    if (new Set(items.map((item) => item.id)).size !== items.length)
      throw new Error("Batch item ids must be unique");
    if (items.some((item) => item.provider !== "codex" && item.provider !== "claude"))
      throw new Error("Every batch item needs a supported provider");
    const retries = Math.max(0, Math.min(3, Math.trunc(input.retries || 0)));
    const timeoutMinutes = Math.max(1, Math.min(180, Math.trunc(input.timeoutMinutes || 30)));
    const validationCommands = input.validationCommands.map((command) => command.trim()).filter(Boolean).slice(0, 10);
    const summary = await new Manager().run({
      objective: input.objective.trim() || `Coordinated batch of ${items.length} tasks`,
      repo: project.repo,
      providers: [...new Set(items.map((item) => item.provider))],
      workItems: items,
      dryRun: Boolean(input.dryRun),
      retries,
      timeoutMs: timeoutMinutes * 60_000,
      integrate: Boolean(input.integrate),
      createPullRequest: Boolean(input.createPullRequest),
      ...(validationCommands.length ? { validationCommands } : {}),
    });
    return {
      runId: summary.runId,
      status: summary.status,
      ...(summary.integrationBranch ? { integrationBranch: summary.integrationBranch } : {}),
      ...(summary.pullRequestUrl ? { pullRequestUrl: summary.pullRequestUrl } : {}),
      review: summary.review,
    };
  });
}
function projectById(projectId: string): Project {
  const project = load().projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error("Project not found. Refresh the workspace and try again.");
  return project;
}
function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => resolve(value).replace(/[\\/]+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}
function projectBrief(project: Project) { const path=join(project.repo,"PROJECT.md"); return {path,content:existsSync(path)?readFileSync(path,"utf8"):"",exists:existsSync(path)}; }
function saveProjectBrief(project: Project,content:string){const brief=projectBrief(project);writeFileSync(brief.path,`${content.trim()}\n`);return projectBrief(project)}
function projectActivity(){return Object.fromEntries(load().projects.map(project=>{const path=join(project.repo,".codepilot","codepilot.db"),pm=pmActivity.get(project.id)??0;if(!existsSync(path))return[project.id,pm];try{using database=new DatabaseSync(path,{readOnly:true});const row=database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status IN ('leased','running','validating')").get() as Record<string,unknown>;return[project.id,Number(row.count)+pm]}catch{return[project.id,pm]}}))}
const defaultAppConfig: AppConfig = { command: "", workingDirectory: ".", url: "http://localhost:3000" };
function appConfigPath(project: Project) { return join(project.repo, ".codepilot", "app-config.json"); }
function readAppConfig(project: Project): AppConfig {
  try { return { ...defaultAppConfig, ...(JSON.parse(readFileSync(appConfigPath(project), "utf8")) as Partial<AppConfig>) }; }
  catch {
    try {
      const pkg = JSON.parse(readFileSync(join(project.repo, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.start) return { ...defaultAppConfig, command: "npm start" };
    } catch { /* Manual configuration is available for non-Node projects. */ }
    return { ...defaultAppConfig };
  }
}
function saveAppConfig(input: AppConfig, project: Project) {
  const command = String(input.command ?? "").trim().slice(0, 1000);
  const workingDirectory = String(input.workingDirectory ?? ".").trim() || ".";
  const cwd = resolve(project.repo, workingDirectory);
  const rel = relative(resolve(project.repo), cwd);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("Working directory must stay inside the project");
  const url = String(input.url ?? "").trim().slice(0, 2000);
  if (url && !/^https?:\/\//i.test(url)) throw new Error("App URL must start with http:// or https://");
  mkdirSync(dirname(appConfigPath(project)), { recursive: true });
  writeFileSync(appConfigPath(project), JSON.stringify({ command, workingDirectory, url }, null, 2));
}
function projectAppStatus(project: Project) {
  const process = appProcesses.get(project.id), state = appProcessState.get(project.id) ?? { logs: [] };
  return { configured: Boolean(readAppConfig(project).command), running: Boolean(process && process.exitCode === null), ...(process?.pid ? { pid: process.pid } : {}), ...(state.startedAt ? { startedAt: state.startedAt } : {}), config: readAppConfig(project), logs: state.logs };
}
function projectEnvironment(...directories: string[]): NodeJS.ProcessEnv {
  const mode = process.env.NODE_ENV?.trim();
  const names = [".env", ...(mode ? [`.env.${mode}`] : []), ".env.local", ...(mode ? [`.env.${mode}.local`] : [])];
  const values: NodeJS.ProcessEnv = {};
  for (const directory of [...new Set(directories)]) for (const name of names) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[2] ?? "";
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, "").trim();
      values[match[1]] = value;
    }
  }
  return values;
}
function startProjectApp(project: Project) {
  const current = appProcesses.get(project.id);
  if (current?.exitCode === null) return projectAppStatus(project);
  const config = readAppConfig(project);
  if (!config.command) throw new Error("Configure a start command first");
  const cwd = resolve(project.repo, config.workingDirectory);
  if (!existsSync(cwd)) throw new Error("Configured working directory does not exist");
  const state = { startedAt: new Date().toISOString(), logs: [] as string[] };
  const child = spawn(config.command, { cwd, shell: true, windowsHide: true, env: { ...isolatedAgentEnvironment(), ...projectEnvironment(project.repo, cwd) } });
  const append = (prefix: string, chunk: Buffer) => { state.logs.push(`${prefix}${chunk.toString("utf8")}`); state.logs = state.logs.slice(-200); };
  child.stdout?.on("data", (chunk: Buffer) => append("", chunk));
  child.stderr?.on("data", (chunk: Buffer) => append("[stderr] ", chunk));
  child.once("error", (error) => state.logs.push(`[error] ${error.message}`));
  child.once("exit", (code) => { state.logs.push(`[codePilot] App exited with code ${code ?? "unknown"}.`); appProcesses.delete(project.id); });
  appProcesses.set(project.id, child); appProcessState.set(project.id, state);
  return projectAppStatus(project);
}
function stopProjectApp(project: Project) {
  const child = appProcesses.get(project.id);
  if (child?.pid) {
    if (process.platform === "win32") { try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch { child.kill(); } }
    else child.kill("SIGTERM");
    appProcesses.delete(project.id);
    appProcessState.get(project.id)?.logs.push("[codePilot] App stopped by user.");
  }
  return projectAppStatus(project);
}
function clearProjectPort(project: Project) {
  stopProjectApp(project);
  const config = readAppConfig(project);
  let parsed: URL;
  try { parsed = new URL(config.url); } catch { throw new Error("Configure a valid http:// or https:// app URL before clearing its port."); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Configure an http:// or https:// app URL before clearing its port.");
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Configure a valid app URL port before clearing it.");
  if (process.platform === "win32") {
    const output = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true });
    const pids = [...new Set(output.split(/\r?\n/).flatMap((line) => { const fields = line.trim().split(/\s+/); const localAddress = fields[1] ?? ""; return fields[0]?.toUpperCase() === "TCP" && (localAddress.endsWith(`:${port}`) || localAddress.endsWith(`]:${port}`)) && fields[3]?.toUpperCase() === "LISTENING" && /^\d+$/.test(fields[4] ?? "") ? [fields[4]] : []; }))];
    for (const pid of pids) {
      try { execFileSync("taskkill", ["/pid", pid, "/T", "/F"], { windowsHide: true, stdio: "pipe" }); }
      catch {
        try {
          const args = `'/pid ${pid} /T /F'`;
          execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$p = Start-Process -FilePath taskkill.exe -ArgumentList ${args} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`], { windowsHide: true, stdio: "pipe" });
        } catch { throw new Error(`Windows denied clearing port ${port} (PID ${pid}). Approve the administrator prompt and try again.`); }
      }
    }
  }
  return projectAppStatus(project);
}
function knowledgeDir(project: Project) {
  return join(project.repo, ".codepilot", "knowledge");
}
function entries(directory: string): KnowledgeEntry[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        return [
          JSON.parse(
            readFileSync(join(directory, name), "utf8"),
          ) as KnowledgeEntry,
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function history(project: Project): ChatMessage[] {
  try {
    return JSON.parse(
      readFileSync(
        join(project.repo, ".codepilot", "knowledge-chat.json"),
        "utf8",
      ),
    ) as ChatMessage[];
  } catch {
    return [];
  }
}
function knowledgeState(project: Project): KnowledgeState {
  return { entries: entries(knowledgeDir(project)), messages: history(project) };
}
function saveEntry(project: Project, entry: KnowledgeEntry) {
  mkdirSync(knowledgeDir(project), { recursive: true });
  writeFileSync(
    join(knowledgeDir(project), `${entry.id}.json`),
    JSON.stringify(entry, null, 2),
  );
}
function saveChat(project: Project, messages: ChatMessage[]) {
  const path = join(project.repo, ".codepilot", "knowledge-chat.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(messages.slice(-100), null, 2));
}
function pmPaths(repo: string) {
  return {
    chat: join(repo, ".codepilot", "pm-chat.json"),
  };
}
function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function matchesPMTask(objective: string, title: string, taskId?: string): boolean {
  const marker = objective.match(/^codePilot PM task: ([^\r\n]+)$/m)?.[1];
  if (marker) return marker === taskId;
  const words = (value: string) =>
    new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const taskWords = words(title);
  const runWords = words(objective.split(/\r?\n/, 1)[0] ?? "");
  if (!taskWords.size || !runWords.size) return false;
  const overlap = [...taskWords].filter((word) => runWords.has(word)).length;
  return overlap / Math.min(taskWords.size, runWords.size) >= 0.8;
}
function pmState(repo: string): PMState {
  const paths = pmPaths(repo);
  const storedTasks = loadPMTasks(repo) as PMTask[];
  const committedTaskIds = new Set(
    loadPMTaskBins(repo).flatMap((bin) => bin.taskIds),
  );
  for (const task of storedTasks)
    if (task.status === "committed") committedTaskIds.add(task.id);
  let tasks = storedTasks
    .filter((task) => !committedTaskIds.has(task.id))
    .map((task) => ({
    ...task,
    queueId: task.queueId?.trim() || "general",
    queueTitle: task.queueTitle?.trim() || "General",
    dependencies: Array.isArray(task.dependencies)
      ? [...new Set(task.dependencies.filter((dependency) => typeof dependency === "string" && dependency.trim() && !committedTaskIds.has(dependency)).map((dependency) => dependency.trim()))]
      : [],
    }));
  const databasePath = join(repo, ".codepilot", "codepilot.db");
  if (existsSync(databasePath)) {
    try {
      using database = new DatabaseSync(databasePath, { readOnly: true });
      const runs = (
        database
          .prepare("SELECT objective, status, updated_at FROM runs ORDER BY created_at DESC")
          .all() as Array<Record<string, unknown>>
      ).map((row) => ({
        objective: String(row.objective),
        status: String(row.status),
        updatedAt: String(row.updated_at ?? ""),
      }));
      for (const task of tasks) {
        if (task.status === "done" || task.status === "committed") continue;
        const latestRun = runs.find((run) =>
          matchesPMTask(run.objective, task.title, task.id),
        );
        if (!latestRun) continue;
        // A manual requeue is newer than the failed run it is recovering.
        // Do not resurrect that historical failure on every PM refresh.
        if (["failed", "needs_review", "completed"].includes(latestRun.status) && latestRun.updatedAt && task.updatedAt > latestRun.updatedAt) continue;
        const nextStatus =
          latestRun.status === "completed"
            ? "done"
            : latestRun.status === "running"
              ? "launched"
              : latestRun.status === "failed" || latestRun.status === "needs_review"
                ? "ready"
                : task.status;
        if (task.status !== nextStatus || task.lastRunStatus !== latestRun.status) {
          task.status = nextStatus;
          task.lastRunStatus = latestRun.status;
        }
      }
    } catch {
      // PM history remains usable if a project database is temporarily locked.
    }
  }
  try {
    tasks = reconcileTaskStatuses(tasks);
  } catch {
    // Keep corrupted historical state visible but never runnable. New PM
    // operations are validated strictly before they are saved.
    tasks = tasks.map((task) =>
      task.status === "done" || task.status === "launched" || task.status === "committed"
        ? task
        : { ...task, status: "blocked" },
    );
  }
  if (JSON.stringify(tasks) !== JSON.stringify(storedTasks)) {
    savePMTasks(repo, tasks);
  }
  return {
    tasks: (() => {
      try {
        return topologicallySortTasks(tasks);
      } catch {
        return tasks;
      }
    })(),
    messages: readJson<ChatMessage[]>(paths.chat, []),
  };
}
function pmTaskDetail(project: Project, id: string) {
  const state = pmState(project.repo), task = state.tasks.find((item) => item.id === id);
  if (!task) throw new Error("Task not found");
  const prerequisites = task.dependencies.map((dependency) => {
    const prerequisite = state.tasks.find((item) => item.id === dependency)!;
    return { id: prerequisite.id, title: prerequisite.title, status: prerequisite.status };
  });
  const databasePath = join(project.repo, ".codepilot", "codepilot.db");
  if (!existsSync(databasePath)) return { task, prerequisites, workers: [], events: [] };
  using database = new DatabaseSync(databasePath, { readOnly: true });
  const runs = database.prepare("SELECT id, objective, status, created_at, updated_at FROM runs ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
  const run = runs.find((item) => matchesPMTask(String(item.objective), task.title, task.id));
  if (!run) return { task, prerequisites, workers: [], events: [] };
  const workers = database.prepare("SELECT id, provider, status FROM tasks WHERE run_id = ? ORDER BY created_at").all(String(run.id)) as Array<Record<string, unknown>>;
  const events = workers.flatMap((worker) => (database.prepare("SELECT timestamp, stream, payload FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 12").all(String(worker.id)) as Array<Record<string, unknown>>).map((event) => ({ timestamp: String(event.timestamp), stream: String(event.stream), payload: JSON.parse(String(event.payload)) as unknown }))).sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-20);
  return { task, prerequisites, run: { id: String(run.id), status: String(run.status), objective: String(run.objective), createdAt: String(run.created_at), updatedAt: String(run.updated_at) }, workers: workers.map((worker) => ({ taskId: String(worker.id), provider: String(worker.provider), status: String(worker.status) })), events };
}
function savePM(repo: string, state: PMState) {
  const paths = pmPaths(repo);
  mkdirSync(dirname(paths.chat), { recursive: true });
  savePMTasks(repo, state.tasks);
  writeFileSync(
    paths.chat,
    JSON.stringify(state.messages.slice(-100), null, 2),
  );
}
function ensureProjectGit(repo: string, initialize = false) {
  const root = resolve(repo);
  if (initialize) {
    mkdirSync(root, { recursive: true });
    execFileSync("git", ["init", root]);
  } else {
    const gitRoot = canonicalGitRepository(root);
    if (!samePath(gitRoot, root)) throw new Error("Each codePilot project must be its own Git repository, not a subdirectory of another repository.");
  }
  const ignorePath = initialize
    ? join(root, ".gitignore")
    : resolve(root, execFileSync("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8", windowsHide: true }).trim());
  const existing = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  if (!/(^|\r?\n)\.codepilot\/?(?:\r?\n|$)/m.test(existing)) {
    mkdirSync(dirname(ignorePath), { recursive: true });
    writeFileSync(ignorePath, `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}.codepilot/\n`);
    if (initialize) execFileSync("git", ["-C", root, "add", ".gitignore"]);
  }
}
function commitPMTaskBin(project: Project, taskIds: string[]): TaskBin {
  const state = pmState(project.repo);
  const selected = [...new Set(taskIds)].map((id) => state.tasks.find((task) => task.id === id)).filter((task): task is PMTask => Boolean(task));
  if (!selected.length) throw new Error("Select at least one task to create a commit bin.");
  const status = execFileSync("git", ["-C", project.repo, "status", "--porcelain"], { encoding: "utf8" });
  if (status.trim()) throw new Error("Commit or stash project changes before archiving completed tasks.");
  const createdAt = new Date().toISOString();
  const hash = createHash("sha256").update(`${createdAt}\n${selected.map((task) => task.id).join("\n")}\n${status}`).digest("hex").slice(0, 12);
  const message = `codePilot task bin ${hash}`;
  execFileSync("git", ["-C", project.repo, "-c", "user.name=codePilot", "-c", "user.email=codepilot@local", "commit", "--allow-empty", "-m", message, "-m", `No source changes; task completion recorded by codePilot.\n\nTasks:\n${selected.map((task) => `- ${task.id}: ${task.title}`).join("\n")}`], { stdio: "pipe" });
  const commit = execFileSync("git", ["-C", project.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const bin: TaskBin = { name: "committed", hash, taskIds: selected.map((task) => task.id), taskTitles: selected.map((task) => task.title), tasks: selected, commit, createdAt };
  const committedIds = new Set(bin.taskIds);
  state.tasks = cycleTasksOut(state.tasks, committedIds);
  saveCommittedTaskBin(project.repo, bin, state.tasks);
  return bin;
}
function createPMTask(project: Project, input: NewPMTask): PMState {
  const title = input.title.trim(), description = input.description.trim();
  if (!title || !description) throw new Error("Task title and description are required.");
  const state = pmState(project.repo), now = new Date().toISOString();
  const task: PMTask = { id: randomUUID(), title, description, acceptanceCriteria: (input.acceptanceCriteria ?? []).map((item) => item.trim()).filter(Boolean), priority: input.priority === "high" || input.priority === "low" ? input.priority : "medium", status: "ready", queueId: "deploy", queueTitle: "Deploy queue", dependencies: [], recommendedProvider: input.recommendedProvider === "claude" ? "claude" : "codex", createdAt: now, updatedAt: now };
  state.tasks.push(task);
  state.tasks = reconcileTaskStatuses(state.tasks);
  savePM(project.repo, state);
  return pmState(project.repo);
}
function deletePMTask(project: Project, id: string): PMState {
  const state = pmState(project.repo);
  if (!state.tasks.some((task) => task.id === id)) throw new Error("Task not found");
  state.tasks = omitTaskDependencies(state.tasks.filter((task) => task.id !== id), new Set([id]));
  state.tasks = reconcileTaskStatuses(state.tasks);
  savePM(project.repo, state);
  return pmState(project.repo);
}
const schema = {
  type: "object",
  properties: {
    message: { type: "string" },
    operations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "update", "delete"] },
          id: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          published: { type: "boolean" },
        },
        required: ["action", "id", "title", "content", "tags", "published"],
        additionalProperties: false,
      },
    },
  },
  required: ["message", "operations"],
  additionalProperties: false,
};
async function chat(project: Project, message: string) {
  if (!message.trim()) throw new Error("Message required");
  const before = entries(knowledgeDir(project)),
    messages = history(project),
    temp = join(app.getPath("temp"), `codepilot-chat-${randomUUID()}`);
  mkdirSync(temp, { recursive: true });
  const schemaPath = join(temp, "schema.json"),
    output = join(temp, "output.json");
  writeFileSync(schemaPath, JSON.stringify(schema));
  const prompt = `You curate durable project knowledge for ${project.name}. Answer questions and return structured operations only when the user asks to change knowledge. Use exact ids for update/delete. Published entries are given to coding agents. Existing entries: ${JSON.stringify(before)}. Recent conversation: ${JSON.stringify(messages.slice(-12))}. User: ${message}`;
  await run("codex", [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--cd",
    project.repo,
    "--output-schema",
    schemaPath,
    "--output-last-message",
    output,
    prompt,
  ]);
  const response = JSON.parse(readFileSync(output, "utf8")) as {
    message: string;
    operations: Array<{
      action: string;
      id: string;
      title: string;
      content: string;
      tags: string[];
      published: boolean;
    }>;
  };
  let applied = 0;
  for (const operation of response.operations ?? []) {
    if (
      operation.action === "add" &&
      operation.title.trim() &&
      operation.content.trim()
    ) {
      const now = new Date().toISOString();
      saveEntry(project, {
        id: randomUUID(),
        title: operation.title.trim(),
        content: operation.content.trim(),
        tags: operation.tags,
        published: operation.published,
        createdAt: now,
        updatedAt: now,
      });
      applied++;
    } else if (operation.action === "update") {
      const old = before.find((item) => item.id === operation.id);
      if (old && operation.title.trim() && operation.content.trim()) {
        saveEntry(project, {
          ...old,
          title: operation.title.trim(),
          content: operation.content.trim(),
          tags: operation.tags,
          published: operation.published,
          updatedAt: new Date().toISOString(),
        });
        applied++;
      }
    } else if (
      operation.action === "delete" &&
      before.some((item) => item.id === operation.id)
    ) {
      rmSync(join(knowledgeDir(project), `${operation.id}.json`), { force: true });
      applied++;
    }
  }
  const now = new Date().toISOString();
  saveChat(project, [
    ...messages,
    { role: "user", content: message, timestamp: now },
    {
      role: "assistant",
      content: response.message,
      timestamp: now,
      ...(applied ? { operations: applied } : {}),
    },
  ]);
  rmSync(temp, { recursive: true, force: true });
  return knowledgeState(project);
}
function run(command: string, args: string[], input = ""): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
      env: isolatedAgentEnvironment(),
    });
    child.stdin.end(input);
    let error = "";
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error("AI curator timed out"));
    }, 120000);
    child.stderr.on("data", (chunk: Buffer) => (error += chunk.toString()));
    child.once("error", fail);
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 ? done() : fail(new Error(error || `Exited ${code}`));
    });
  });
}
function registerKnowledgeIPC() {
  ipcMain.handle("knowledge:get", (_event, projectId: string) => knowledgeState(projectById(projectId)));
  ipcMain.handle("knowledge:chat", (_event, projectId: string, message: string) =>
    chat(projectById(projectId), message.slice(0, 8000)),
  );
}
const pmSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
    requiresUserInput: { type: "boolean" },
    continueAutonomously: { type: "boolean" },
    operations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "update", "delete"] },
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
          priority: { type: "string", enum: ["low", "medium", "high"] },
          status: {
            type: "string",
            enum: ["backlog", "blocked", "ready", "launched", "done", "committed"],
          },
          queueId: { type: "string" },
          queueTitle: { type: "string" },
          dependencies: { type: "array", items: { type: "string" } },
          recommendedProvider: {
            type: "string",
            enum: ["codex", "claude", "either"],
          },
        },
        required: [
          "action",
          "id",
          "title",
          "description",
          "acceptanceCriteria",
          "priority",
          "status",
          "queueId",
          "queueTitle",
          "dependencies",
          "recommendedProvider",
        ],
        additionalProperties: false,
      },
    },
    appConfig: {
      anyOf: [
        {
          type: "object",
          properties: {
            command: { type: "string" },
            workingDirectory: { type: "string" },
            url: { type: "string" },
          },
          required: ["command", "workingDirectory", "url"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
  },
  required: ["message", "requiresUserInput", "continueAutonomously", "operations", "appConfig"],
  additionalProperties: false,
};
const pmInstructions = `You are codePilot's project manager. Maintain a coherent ongoing discussion about goals, scope, sequencing, risks, and tradeoffs. Proactively inspect progress, triage failures, identify the next useful work, and recommend Codex, Claude, or either. Inspect the repository read-only when useful. Turn actionable work into concise tasks with testable acceptance criteria. Do not create tasks for casual questions or unresolved ideas. Organize related tasks into a named queue using a stable short queueId and queueTitle. Add dependency task ids whenever a task consumes the output, decision, schema, interface, or infrastructure of another task. Dependencies are execution constraints, not preferences: keep independent tasks dependency-free so they can run concurrently. New tasks should use backlog status; codePilot derives blocked and ready states. Never create a missing dependency, self-dependency, or dependency cycle. For dependencies among tasks added in the same response, refer to the temporary id used by that add operation. Use exact persisted ids from context for existing tasks. Updating an existing task automatically re-queues it after dependency reconciliation, so update only when the work should be reconsidered. PROJECT.md is the Living Brief. When work materially changes scope, behavior, architecture, decisions, or milestones, include updating PROJECT.md in the assigned task's description and acceptance criteria.

Operate autonomously by default. Make reasonable technical and subjective assumptions, record consequential assumptions in the task or Living Brief, and continue. Ordinary task failures, ambiguity with a safe default, and opportunities for follow-up are not reasons to ask the user; triage them into revised or new work. Set requiresUserInput=true only when progress genuinely cannot continue without organic user input, an irreversible/high-impact choice with no safe assumption, credentials/authority only the user can provide, or hands-on user testing that is now required. Never ask a bundle of speculative questions. Set continueAutonomously=true whenever useful implementation, verification, repair, documentation, or project-completion work remains and does not require that input. Set it false only when user input/testing is required or the project objective is genuinely finished. When the user asks you to configure how the project app starts, return appConfig with a start command, repo-relative workingDirectory, and local http(s) URL; otherwise appConfig must be null. Configuration never launches the app. Always return the requested structured response.`;

function relevantPMContext(message: string, state: PMState, knowledge: KnowledgeEntry[]) {
  const terms = new Set(message.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const score = (text: string) => (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).reduce((total, word) => total + (terms.has(word) ? 1 : 0), 0);
  const rankedTasks = [...state.tasks].sort((a, b) => score(`${b.title} ${b.description}`) - score(`${a.title} ${a.description}`));
  const rankedKnowledge = [...knowledge].sort((a, b) => score(`${b.title} ${b.content} ${b.tags.join(" ")}`) - score(`${a.title} ${a.content} ${a.tags.join(" ")}`));
  return {
    tasks: rankedTasks.filter((task, index) => index < 8 && (index < 3 || score(`${task.title} ${task.description}`) > 0)),
    knowledge: rankedKnowledge.filter((entry, index) => index < 5 && (index < 2 || score(`${entry.title} ${entry.content}`) > 0)),
    recentConversation: state.messages.slice(-8),
  };
}

async function persistentPMReply(project: Project, prompt: string): Promise<string> {
  const threadPath = join(project.repo, ".codepilot", "pm-thread.json");
  let threadId = pmThreads.get(project.id);
  if (!threadId) try { threadId = (JSON.parse(readFileSync(threadPath, "utf8")) as { threadId?: string }).threadId; } catch { /* Start a new project thread. */ }
  if (threadId) {
    try { if (!pmThreads.has(project.id)) await pmServer.resumeThread(threadId, project.repo, pmInstructions); }
    catch { threadId = undefined; }
  }
  if (!threadId) {
    threadId = await pmServer.startThread(project.repo, pmInstructions);
    mkdirSync(dirname(threadPath), { recursive: true });
    writeFileSync(threadPath, JSON.stringify({ threadId }, null, 2));
  }
  pmThreads.set(project.id, threadId);
  return await pmServer.turn(threadId, project.repo, prompt, pmSchema);
}
async function chatPM(message: string, targetProject: Project) {
  if (!message.trim()) throw new Error("Message required");
  const project = targetProject,
    before = pmState(project.repo),
    knowledge = entries(join(project.repo, ".codepilot", "knowledge")),
    temp = join(app.getPath("temp"), `codepilot-pm-${randomUUID()}`);
  mkdirSync(temp, { recursive: true });
  const schemaPath = join(temp, "schema.json"),
    output = join(temp, "output.json");
  writeFileSync(schemaPath, JSON.stringify(pmSchema));
  const context = relevantPMContext(message, before, knowledge);
  const prompt = `Project: ${project.name}. Living Brief (PROJECT.md): ${projectBrief(project).content || "Not created yet."}. Use exact ids for task updates/deletes and dependency references to existing tasks. New add operations may depend on the temporary ids of other add operations in this same response. Relevant current context: ${JSON.stringify(context)}. User: ${message}`;
  try {
    let raw: string;
    try {
      raw = await persistentPMReply(project, prompt);
    } catch {
      pmThreads.delete(project.id);
      await run(
        "codex",
        ["exec", "--ephemeral", "--sandbox", "read-only", "--cd", project.repo, "--output-schema", schemaPath, "--output-last-message", output, "Act as the codePilot project manager. Use the complete instructions and project context provided on stdin."],
        `${pmInstructions}\n\n${prompt}`,
      );
      raw = readFileSync(output, "utf8");
    }
    const response = JSON.parse(raw) as {
      message: string;
      requiresUserInput: boolean;
      continueAutonomously: boolean;
      appConfig: AppConfig | null;
      operations: Array<
        Omit<PMTask, "createdAt" | "updatedAt"> & {
          action: "add" | "update" | "delete";
          recommendedProvider: "codex" | "claude" | "either";
        }
      >;
    };
    const committedTaskIds = new Set(
      loadPMTaskBins(project.repo).flatMap((bin) => bin.taskIds),
    );
    const deletedTaskIds = new Set<string>();
    let tasks = [...before.tasks],
      applied = 0;
    const operations = response.operations ?? [];
    const addIds = new Map<string, string>();
    const generatedAddIds = new Map<number, string>();
    for (const [index, operation] of operations.entries()) {
      if (operation.action !== "add") continue;
      const temporaryId = operation.id.trim();
      const generatedId = randomUUID();
      generatedAddIds.set(index, generatedId);
      // Temporary ids only connect dependencies within this response. They
      // are helpful but not required; persisted ids are always manager-owned.
      if (temporaryId && !addIds.has(temporaryId))
        addIds.set(temporaryId, generatedId);
    }
    const resolveDependencies = (dependencies: string[]) =>
      dependencies
        .map((dependency) => dependency.trim())
        .filter(Boolean)
        .map((dependency) => addIds.get(dependency) ?? dependency)
        // Committed-bin tasks have already satisfied their dependency. They
        // are deliberately absent from the active graph.
        .filter((dependency) => !committedTaskIds.has(dependency));
    for (const [index, operation] of operations.entries()) {
      const now = new Date().toISOString();
      if (
        operation.action === "add" &&
        operation.title.trim() &&
        operation.description.trim()
      ) {
        tasks.push({
          id: generatedAddIds.get(index)!,
          title: operation.title.trim(),
          description: operation.description.trim(),
          acceptanceCriteria: operation.acceptanceCriteria
            .map((item) => item.trim())
            .filter(Boolean),
          priority: operation.priority,
          status: "backlog",
          queueId: operation.queueId.trim() || "general",
          queueTitle: operation.queueTitle.trim() || "General",
          dependencies: resolveDependencies(operation.dependencies),
          recommendedProvider: operation.recommendedProvider,
          createdAt: now,
          updatedAt: now,
        });
        applied++;
      } else if (operation.action === "update") {
        const index = tasks.findIndex((task) => task.id === operation.id);
        if (index >= 0) {
          const current = tasks[index]!;
          const resolvesFailure = ["failed", "needs_review"].includes(current.lastRunStatus ?? "");
          tasks[index] = {
            ...current,
            title: operation.title.trim(),
            description: operation.description.trim(),
            acceptanceCriteria: operation.acceptanceCriteria
              .map((item) => item.trim())
              .filter(Boolean),
            priority: operation.priority,
            queueId: operation.queueId.trim() || "general",
            queueTitle: operation.queueTitle.trim() || "General",
            dependencies: resolveDependencies(operation.dependencies),
            recommendedProvider: operation.recommendedProvider,
            // A PM edit is new work: re-queue it before dependency reconciliation.
            status: "backlog",
            ...(resolvesFailure ? { lastRunStatus: undefined, summary: undefined } : {}),
            updatedAt: now,
          };
          applied++;
        }
      } else if (operation.action === "delete") {
        const length = tasks.length;
        tasks = tasks.filter((task) => task.id !== operation.id);
        if (tasks.length < length) {
          deletedTaskIds.add(operation.id);
          applied++;
        }
      }
    }
    tasks = omitTaskDependencies(tasks, deletedTaskIds);
    validateTaskGraph(tasks);
    tasks = reconcileTaskStatuses(tasks);
    if (response.appConfig) {
      saveAppConfig(response.appConfig, project);
      applied++;
    }
    const now = new Date().toISOString(),
      next = {
        tasks,
        messages: [
          ...before.messages,
          { role: "user" as const, content: message, timestamp: now },
          {
            role: "assistant" as const,
            content: response.message,
            timestamp: now,
            ...(applied ? { operations: applied } : {}),
          },
        ],
      };
    savePM(project.repo, next);
    return {
      ...pmState(project.repo),
      requiresUserInput: Boolean(response.requiresUserInput),
      continueAutonomously: Boolean(response.continueAutonomously),
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
function registerPMIPC() {
  ipcMain.handle("pm:get", (_event, projectId: string) => pmState(projectById(projectId).repo));
  ipcMain.handle("pm:task-detail", (_event, projectId: string, id: string) => pmTaskDetail(projectById(projectId), id));
  ipcMain.handle("pm:chat", async (_event, projectId: string, message: string) => {
    const project = projectById(projectId);
    pmActivity.set(project.id, (pmActivity.get(project.id) ?? 0) + 1);
    try {
      const state = await pmTurns.run(project.id, () => chatPM(message.slice(0, 8000), project));
      if (state.requiresUserInput)
        for (const browserWindow of BrowserWindow.getAllWindows())
          browserWindow.webContents.send("pm:user-input-required", project.id);
      return state;
    } finally {
      const remaining = (pmActivity.get(project.id) ?? 1) - 1;
      if (remaining > 0) pmActivity.set(project.id, remaining);
      else pmActivity.delete(project.id);
    }
  });
  ipcMain.handle("pm:clear-chat", (_event, projectId: string) => {
    const project = projectById(projectId),
      state = pmState(project.repo),
      next = { ...state, messages: [] };
    pmThreads.delete(project.id);
    rmSync(join(project.repo, ".codepilot", "pm-thread.json"), { force: true });
    savePM(project.repo, next);
    return next;
  });
  ipcMain.handle(
    "pm:task-status",
      (_event, projectId: string, id: string, status: PMTask["status"], summary?: string) => {
      if (!["backlog", "blocked", "ready", "launched", "done", "committed"].includes(status))
        throw new Error("Invalid task status");
      const project = projectById(projectId),
        state = pmState(project.repo),
        task = state.tasks.find((item) => item.id === id);
      if (!task) throw new Error("Task not found");
      if (status === "launched") assertTaskLaunchable(id, state.tasks);
        task.status = status;
        if (summary?.trim()) task.summary = summary.trim().slice(0, 4000);
        else if (["backlog", "launched"].includes(status)) task.summary = undefined;
      if (["backlog", "ready"].includes(status) && ["failed", "needs_review"].includes(task.lastRunStatus ?? "")) task.lastRunStatus = undefined;
      task.updatedAt = new Date().toISOString();
      state.tasks = reconcileTaskStatuses(state.tasks);
      savePM(project.repo, state);
      return pmState(project.repo);
    },
  );
  ipcMain.handle("pm:task-failure", (_event, projectId: string, id: string, summary: string) => {
    const project = projectById(projectId),
      state = pmState(project.repo),
      task = state.tasks.find((item) => item.id === id);
    if (!task) throw new Error("Task not found");
    const failure = {
      timestamp: new Date().toISOString(),
      summary: summary.trim().slice(0, 4000) || "Agent run failed without a diagnostic.",
    };
    task.status = "ready";
    task.summary = failure.summary;
    task.lastRunStatus = "failed";
    task.failures = [...(task.failures ?? []), failure].slice(-20);
    task.updatedAt = failure.timestamp;
    state.tasks = reconcileTaskStatuses(state.tasks);
    savePM(project.repo, state);
    return pmState(project.repo);
  });
  ipcMain.handle("pm:commit-bin", (_event, projectId: string, taskIds: string[]) => commitPMTaskBin(projectById(projectId), taskIds));
  ipcMain.handle("pm:create-task", (_event, projectId: string, input: NewPMTask) => createPMTask(projectById(projectId), input));
  ipcMain.handle("pm:delete-task", (_event, projectId: string, id: string) => deletePMTask(projectById(projectId), id));
}
function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#09090b",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#09090b", symbolColor: "#a1a1aa", height: 42 },
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL)
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else
    void window.loadFile(
      join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
}
app.whenReady().then(() => {
  recoverInterruptedRuns();
  registerIPC();
  registerKnowledgeIPC();
  registerPMIPC();
  registerAgentIPC();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  pmServer.stop();
  for (const child of appProcesses.values()) {
    if (!child.pid) continue;
    if (process.platform === "win32") { try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch { child.kill(); } }
    else child.kill("SIGTERM");
  }
});
