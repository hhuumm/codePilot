import React, { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ArrowsPointingInIcon, ArrowsPointingOutIcon, BoltIcon, ChevronLeftIcon, ChevronRightIcon, CircleStackIcon, ClipboardDocumentListIcon, Cog6ToothIcon, CommandLineIcon, FolderIcon, PlayIcon, QueueListIcon, SignalIcon, Squares2X2Icon, StopIcon, WrenchScrewdriverIcon } from "@heroicons/react/24/outline";
import type { AppStatus, DesktopState, PMTask } from "./types";
import { Agents } from "./agents";
import { ActiveAgents } from "./active-agents";
import { Knowledge } from "./knowledge";
import { PM } from "./pm";
import { RunHistory } from "./run-history";
import { TaskBoard } from "./task-board";
import { AppControl } from "./app-control";
import { Settings } from "./settings";
import { ProjectSettings } from "./project-settings";
import "./styles.css";

type View = "overview" | "pm" | "tasks" | "agents" | "active-agents" | "runtime" | "projects" | "knowledge" | "settings" | "project-settings" | "global-chat";

function App() {
  const [state, setState] = useState<DesktopState>();
  const [view, setView] = useState<View>("overview");
  const [name, setName] = useState("");
  const [onboardingMessage, setOnboardingMessage] = useState<string>();
  const [triageMessage, setTriageMessage] = useState<string>();
  const [triageTaskIds, setTriageTaskIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [pmExpanded, setPMExpanded] = useState(false);
  const [agentsActive, setAgentsActive] = useState(false);
  const [appStatus, setAppStatus] = useState<AppStatus>();
  const [projectActivity, setProjectActivity] = useState<Record<string,number>>({});
  const [projectTransition, setProjectTransition] = useState<{ from: string; to: string }>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const previousProjectId = useRef<string | undefined>(undefined);
  useEffect(() => { void window.codepilot.getState().then(setState); }, []);
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    const audio = new Audio(new URL("./assets/user-input-required.wav", import.meta.url).href);
    audio.preload = "auto";
    return window.codepilot.onPMUserInputRequired(() => {
      audio.currentTime = 0;
      void audio.play().catch(() => undefined);
    });
  }, []);
  useEffect(()=>{if(typeof window.codepilot.getProjectActivity!=="function")return;let mounted=true;const refresh=()=>void window.codepilot.getProjectActivity().then(next=>mounted&&setProjectActivity(next)).catch(()=>{});refresh();const timer=window.setInterval(refresh,2000);return()=>{mounted=false;window.clearInterval(timer)}},[]);
  useEffect(() => {
    let mounted = true;
    const refresh = () => void window.codepilot.getActiveAgents().then((agents) => mounted && setAgentsActive(agents.length > 0)).catch(() => mounted && setAgentsActive(false));
    refresh(); const timer = window.setInterval(refresh, 2000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [state?.activeProjectId]);
  useEffect(() => { if (!state?.activeProjectId) return; if (!previousProjectId.current) { previousProjectId.current = state.activeProjectId; return; } if (previousProjectId.current !== state.activeProjectId) { const from = state.projects.find((project) => project.id === previousProjectId.current)?.name ?? "Previous project"; const to = state.projects.find((project) => project.id === state.activeProjectId)?.name ?? "Selected project"; setProjectTransition({ from, to }); previousProjectId.current = state.activeProjectId; window.setTimeout(() => setProjectTransition(undefined), 650); } }, [state?.activeProjectId, state?.projects]);
  useEffect(() => {
    if (!state?.activeProjectId) return;
    setAppStatus(undefined);
    let mounted = true;
    const refresh = () => void window.codepilot.getAppStatus().then((status) => mounted && setAppStatus(status)).catch(() => mounted && setAppStatus(undefined));
    refresh(); const timer = window.setInterval(refresh, 2000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [state?.activeProjectId]);
  if (!state) return <div className="grid h-full place-items-center text-zinc-500">Starting codePilot…</div>;
  state.globalSettings ??= { defaultProvider: "codex", scaffold: { mode: "guided", autoDeploy: true, onboardingPrompt: "" } };
  state.globalSettings.scaffold ??= { mode: "guided", autoDeploy: true, onboardingPrompt: "" };
  const active = state.projects.find((project) => project.id === state.activeProjectId)!;
  const sidebarCompact = sidebarCollapsed || windowWidth < 1180;
  function triageTasks(tasks: PMTask[]) {
    const single = tasks.length === 1 ? tasks[0] : undefined;
    setTriageTaskIds(tasks.map((task) => task.id));
    setTriageMessage(single
      ? `Let's triage task "${single.title}". Review its current state, blockers, acceptance criteria, failure history, and recommend the next action.`
      : `Re-triage all ${tasks.length} active Task Board items as one coordinated planning pass. Review priorities, blockers, dependencies, acceptance criteria, and failure histories. Update the existing tasks in place; do not create duplicates. Decide which work belongs in backlog, blocked, or ready, and explain the recommended execution order.\n\n${tasks.map((task, index) => `${index + 1}. [${task.id}] ${task.title} — status: ${task.status}; priority: ${task.priority}; queue: ${task.queueTitle}${task.summary ? `; latest: ${task.summary}` : ""}${task.failures?.length ? `; failures: ${task.failures.length}` : ""}`).join("\n")}\n\nTriage request: ${new Date().toISOString()}`);
    setView("pm");
  }
  function reviewProject() {
    setTriageTaskIds([]);
    setTriageMessage(`Review the current state and progress of project "${active.name}". Assess completed work, active and failed tasks, backlog quality, blockers, dependencies, recent failures, and whether the current priorities still make sense. Summarize what has changed, identify risks or gaps, and recommend the next best actions. Do not create duplicate tasks; only propose or update work when the review supports it.\n\nProject review request: ${new Date().toISOString()}`);
    setView("pm");
  }
  async function switchProject(projectId: string) { const nextProject = state?.projects.find((project) => project.id === projectId); if (!nextProject || nextProject.id === active.id) return; setProjectTransition({ from: active.name, to: nextProject.name }); setOnboardingMessage(undefined); try { setState(await window.codepilot.switchProject(projectId)); } finally { window.setTimeout(() => setProjectTransition(undefined), 650); } }
  async function add() { try { const settings=await window.codepilot.getGlobalSettings();const scaffold=settings.scaffold??{mode:"guided",autoDeploy:true,onboardingPrompt:"Help me define the requirements for this new project."};const projectName=name.trim();const next=await window.codepilot.addProject({name:projectName});setState(next);setName("");setError("");if(scaffold.mode==="guided"){setOnboardingMessage(`We just created a new project named ${projectName}. ${scaffold.onboardingPrompt}`);setView("pm")}else setOnboardingMessage(undefined); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }
  return <div className="grid-bg flex h-full overflow-hidden bg-zinc-950 pt-10">
    <div className="drag fixed inset-x-0 top-0 h-10 border-b border-white/5" />
    <aside data-compact={sidebarCompact} className={`${view === "pm" && pmExpanded ? "hidden" : "flex"} ${sidebarCompact ? "w-[76px] p-3" : "w-72 p-5"} shrink-0 flex-col border-r border-white/10 bg-zinc-950/90 transition-[width,padding] duration-200`}>
      <div className={`flex items-center ${sidebarCompact ? "flex-col gap-3" : "gap-3 px-2"}`}><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-indigo-500 shadow-lg shadow-indigo-500/30"><BoltIcon className="size-5" /></span>{!sidebarCompact && <div className="min-w-0 flex-1"><div className="text-sm font-semibold">codePilot</div><div className="text-xs text-zinc-500">Desktop control plane</div></div>}<button onClick={() => setSidebarCollapsed((value) => !value)} disabled={windowWidth < 1180} title={sidebarCompact ? (windowWidth < 1180 ? "Sidebar expands automatically on a wider window" : "Expand sidebar") : "Collapse sidebar"} className="no-drag rounded-lg border border-white/10 p-1.5 text-zinc-500 hover:bg-white/5 hover:text-indigo-300 disabled:opacity-30">{sidebarCompact ? <ChevronRightIcon className="size-4" /> : <ChevronLeftIcon className="size-4" />}</button></div>
      <nav className="mt-10 space-y-1">
        <Nav on={() => setView("pm")} active={view === "pm"} icon={<ClipboardDocumentListIcon />}>Project Manager</Nav>
        <Nav on={() => setView("tasks")} active={view === "tasks"} icon={<QueueListIcon />}>Task Board</Nav>
        <Nav on={() => setView("active-agents")} active={view === "active-agents"} icon={<SignalIcon className={agentsActive ? "animate-pulse text-emerald-400 drop-shadow-[0_0_6px_rgba(52,211,153,.8)]" : ""} />}>Agents</Nav>
      <div className="sidebar-subnav ml-5 border-l border-white/10 pl-3"><Nav on={() => setView("agents")} active={view === "agents"} icon={<CommandLineIcon />}>Deploy</Nav></div>
        <Nav on={() => setView("knowledge")} active={view === "knowledge"} icon={<CircleStackIcon />}>Knowledge AI</Nav>
        <Nav on={() => setView("project-settings")} active={view === "project-settings"} icon={<WrenchScrewdriverIcon />}>Project Settings</Nav>
        <Nav on={() => setView("runtime")} active={view === "runtime"} icon={<RuntimeGlyph running={Boolean(appStatus?.running)} />}><span className="flex min-w-0 flex-1 items-center justify-between gap-2"><span className="font-mono text-[11px] tracking-wide">APP CORE</span><span className={`font-mono text-[9px] font-semibold tracking-[.18em] ${appStatus?.running ? "text-emerald-300" : "text-zinc-600"}`}>// {appStatus?.running ? "ON" : "OFF"}</span></span></Nav>
        <div className="my-4 border-t border-white/10" />{!sidebarCompact && <div className="mb-2 px-3 text-[9px] font-semibold uppercase tracking-[.2em] text-violet-400/70">Global</div>}
        <Nav on={() => setView("overview")} active={view === "overview"} icon={<Squares2X2Icon />}>Overview</Nav>
        <Nav on={() => setView("projects")} active={view === "projects"} icon={<FolderIcon />}>Projects</Nav>
        <Nav on={() => setView("settings")} active={view === "settings"} icon={<Cog6ToothIcon />}>Settings</Nav>
      </nav>
      <div className={`mt-auto rounded-xl border border-white/10 bg-white/[.03] ${sidebarCompact ? "p-2" : "p-4"}`}>{!sidebarCompact && <><div className="text-[10px] uppercase tracking-widest text-zinc-600">Active project</div><div className="mt-2 truncate text-sm font-medium">{active.name}</div><div className="mt-1 truncate font-mono text-[10px] text-zinc-600">{active.repo}</div></>}<div className={`${sidebarCompact ? "grid-cols-1" : "mt-4 grid-cols-2"} grid gap-2`}><button title="Open project folder" onClick={() => void window.codepilot.openProjectDirectory()} className="flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[.04] px-2 py-2 text-xs text-zinc-300 hover:bg-white/[.08]"><FolderIcon className="size-4" />{!sidebarCompact && "Folder"}</button><button title={appStatus?.running ? "Stop project app" : "Start project app"} onClick={() => void (appStatus?.running ? window.codepilot.stopProjectApp() : window.codepilot.startProjectApp()).then(setAppStatus).catch(() => setView("runtime"))} className={`analog-control flex items-center justify-center gap-2 rounded-lg border px-2 py-2 text-xs ${appStatus?.running ? "analog-red" : "analog-green"}`}>{appStatus?.running ? <StopIcon className="size-4" /> : <PlayIcon className="size-4" />}{!sidebarCompact && (appStatus?.running ? "Stop" : "Start")}</button></div></div>
    </aside>
    <main className={`min-w-0 flex-1 ${view === "tasks" ? "overflow-hidden" : "overflow-y-auto"} ${view === "pm" && pmExpanded ? "p-4" : "p-10"}`}>
      <div data-pm-expanded={pmExpanded} className={`pm-shell relative ${view === "pm" ? "block" : "hidden"}`}>
        <PM key={active.id} initialMessage={onboardingMessage} triageMessage={triageMessage} triageTaskIds={triageTaskIds} visible={view === "pm"} projectName={active.name} expanded={pmExpanded} onExpand={() => setPMExpanded(value => !value)} />
      </div>
      {view === "pm" ? null : view === "tasks" ? <TaskBoard key={active.id} projectId={active.id} projectName={active.name} onTriage={triageTasks} onReviewProject={reviewProject} /> : view === "agents" ? <Agents onState={setState} /> : view === "active-agents" ? <ActiveAgents /> : view === "runtime" ? <AppControl key={active.id} projectId={active.id} status={appStatus} onStatus={setAppStatus} /> : view === "knowledge" ? <Knowledge /> : view === "project-settings" ? <ProjectSettings projectId={active.id} projectName={active.name}/> : view === "settings" ? <Settings state={state} onState={setState} /> : view === "projects" ? <>
        <Title eyebrow="Workspace registry" title="Projects" text={`Create or switch projects under ${state.projectsDirectory}.`} />
        <div className="mt-8 grid grid-cols-[1fr_380px] gap-6"><div className="space-y-3">{state.projects.map((project) => <button key={project.id} onClick={() => {setOnboardingMessage(undefined);void window.codepilot.switchProject(project.id).then(setState)}} className={`w-full rounded-xl border p-5 text-left ${project.id === active.id ? "border-indigo-400/30 bg-indigo-400/10" : "border-white/10 bg-white/[.025]"}`}><div className="flex items-center justify-between gap-4"><div className="font-medium">{project.name}</div>{Boolean(projectActivity[project.id])&&<span className="flex items-center gap-2 rounded-full bg-emerald-400/10 px-2.5 py-1 text-[10px] font-semibold uppercase text-emerald-300"><span className="size-1.5 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_7px_rgba(52,211,153,.7)]"/>{projectActivity[project.id]} working</span>}</div><div className="mt-2 truncate font-mono text-[10px] text-zinc-600">{project.repo}</div></button>)}</div><div className="h-fit rounded-2xl border border-violet-400/15 bg-violet-400/[.035] p-6"><div className="text-[10px] font-semibold uppercase tracking-[.2em] text-violet-400">Project genesis</div><h2 className="mt-2 text-lg font-semibold">Create a new project</h2><p className="mt-2 text-xs leading-5 text-zinc-500">{state.globalSettings.scaffold.mode==="guided"?"Create the Git foundation, then enter a guided requirements conversation with Project Manager.":"Create a clean Git repository without starting onboarding."}</p><input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&name.trim())void add()}} className="mt-5 w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm outline-none focus:border-violet-400/40" placeholder="What should we call it?" />{error && <p className="mt-2 text-xs text-red-400">{error}</p>}<button disabled={!name.trim()} onClick={() => void add()} className="mt-4 w-full rounded-xl bg-violet-500 px-4 py-3 text-sm font-semibold shadow-[0_0_18px_rgba(139,92,246,.18)] hover:bg-violet-400 disabled:opacity-40">{state.globalSettings.scaffold.mode==="guided"?"Create & begin onboarding":"Create blank project"}</button><div className="mt-4 flex items-center justify-between border-t border-white/10 pt-4 text-[10px] text-zinc-600"><span>Model: <span className="capitalize text-zinc-400">{state.globalSettings.defaultProvider}</span></span><span>{state.globalSettings.scaffold.autoDeploy?"Auto-deploy on":"Auto-deploy off"}</span></div></div></div>
      </> : <RunHistory state={state} />}
    </main>
    {projectTransition && <div className="pointer-events-none fixed inset-0 z-[80] grid place-items-center bg-zinc-950/45 backdrop-blur-[2px]"><div className="rounded-2xl border border-indigo-400/25 bg-zinc-950/95 px-8 py-6 text-center shadow-2xl"><div className="text-[10px] font-semibold uppercase tracking-[.24em] text-indigo-400">Switching project</div><div className="mt-3 flex items-center gap-3 text-sm text-zinc-200"><span className="max-w-40 truncate">{projectTransition.from}</span><span className="text-indigo-400">→</span><span className="max-w-40 truncate">{projectTransition.to}</span></div><p className="mt-3 text-[10px] text-zinc-500">Loading the selected project’s files, tasks, and sessions</p></div></div>}
  </div>;
}

function Nav({ active, on, icon, children }: { active: boolean; on(): void; icon: React.ReactNode; children: React.ReactNode }) { return <button title={typeof children === "string" ? children : "App Core"} onClick={on} className={`sidebar-nav flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${active ? "bg-white/10" : "text-zinc-500 hover:bg-white/5"}`}><span className="size-5 shrink-0">{icon}</span><span className="nav-label min-w-0 flex-1 text-left">{children}</span></button>; }
function RuntimeGlyph({ running }: { running: boolean }) { return <span className={`runtime-glyph ${running ? "runtime-glyph-on" : ""}`} aria-hidden="true"><span className="runtime-orbit" /><span className="runtime-core" /><span className="runtime-node runtime-node-a" /><span className="runtime-node runtime-node-b" /><span className="runtime-node runtime-node-c" /></span>; }
function Title({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) { return <><div className="text-xs font-semibold uppercase tracking-[.2em] text-indigo-400">{eyebrow}</div><h1 className="mt-2 text-2xl font-semibold">{title}</h1><p className="mt-2 text-sm text-zinc-400">{text}</p></>; }
const rendererWindow = window as Window & { __codepilotRoot?: Root };
rendererWindow.__codepilotRoot ??= createRoot(document.getElementById("root")!);
rendererWindow.__codepilotRoot.render(<React.StrictMode><App /></React.StrictMode>);
