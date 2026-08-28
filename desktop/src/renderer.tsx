import React, { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ArrowsPointingInIcon, ArrowsPointingOutIcon, BoltIcon, ChevronLeftIcon, ChevronRightIcon, CircleStackIcon, ClipboardDocumentListIcon, Cog6ToothIcon, CommandLineIcon, FolderIcon, PlayIcon, PlusIcon, QueueListIcon, SignalIcon, Squares2X2Icon, StopIcon, TrashIcon, WrenchScrewdriverIcon, XMarkIcon } from "@heroicons/react/24/outline";
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
type ProjectDialog = "choose" | "github" | "new";

function App() {
  const [state, setState] = useState<DesktopState>();
  const [view, setView] = useState<View>("overview");
  const [name, setName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [projectDialog, setProjectDialog] = useState<ProjectDialog>();
  const [onboardingBusy, setOnboardingBusy] = useState<"local"|"remote"|"">("");
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
    if (!projectDialog || onboardingBusy) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setProjectDialog(undefined); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [projectDialog, onboardingBusy]);
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
    if (!state?.activeProjectId) return;
    const projectId = state.activeProjectId;
    const refresh = () => void window.codepilot.getActiveAgents(projectId).then((agents) => mounted && setAgentsActive(agents.length > 0)).catch(() => mounted && setAgentsActive(false));
    refresh(); const timer = window.setInterval(refresh, 2000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [state?.activeProjectId]);
  useEffect(() => { if (!state?.activeProjectId) return; if (!previousProjectId.current) { previousProjectId.current = state.activeProjectId; return; } if (previousProjectId.current !== state.activeProjectId) { const from = state.projects.find((project) => project.id === previousProjectId.current)?.name ?? "Previous project"; const to = state.projects.find((project) => project.id === state.activeProjectId)?.name ?? "Selected project"; setProjectTransition({ from, to }); previousProjectId.current = state.activeProjectId; window.setTimeout(() => setProjectTransition(undefined), 650); } }, [state?.activeProjectId, state?.projects]);
  useEffect(() => {
    if (!state?.activeProjectId) return;
    setAppStatus(undefined);
    let mounted = true;
    const projectId = state.activeProjectId;
    const refresh = () => void window.codepilot.getAppStatus(projectId).then((status) => mounted && setAppStatus(status)).catch(() => mounted && setAppStatus(undefined));
    refresh(); const timer = window.setInterval(refresh, 2000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [state?.activeProjectId]);
  if (!state) return <div className="grid h-full place-items-center text-zinc-500">Starting codePilot…</div>;
  state.globalSettings ??= { defaultProvider: "codex", scaffold: { mode: "guided", autoDeploy: true, onboardingPrompt: "" } };
  state.globalSettings.scaffold ??= { mode: "guided", autoDeploy: true, onboardingPrompt: "" };
  const active = state.projects.find((project) => project.id === state.activeProjectId)!;
  const projectsDirectory = state.projectsDirectory;
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
  async function removeProject(projectId: string, projectName: string) {
    if (!window.confirm(`Remove "${projectName}" from codePilot?\n\nThe repository and its .codepilot data will stay on disk.`)) return;
    setError("");
    setOnboardingMessage(undefined);
    try { setState(await window.codepilot.removeProject(projectId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function openProjectDialog() { setName(""); setRemoteUrl(""); setError(""); setProjectDialog("choose"); }
  async function add() { try { const settings=await window.codepilot.getGlobalSettings();const scaffold=settings.scaffold??{mode:"guided",autoDeploy:true,onboardingPrompt:"Help me define the requirements for this new project."};const projectName=name.trim();const next=await window.codepilot.addProject({name:projectName});setState(next);setName("");setError("");setProjectDialog(undefined);if(scaffold.mode==="guided"){setOnboardingMessage(`We just created a new project named ${projectName}. ${scaffold.onboardingPrompt}`);setView("pm")}else setOnboardingMessage(undefined); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }
  async function finishRepositoryOnboarding(next: DesktopState, source: "local"|"remote") {
    const project = next.projects.find((candidate) => candidate.id === next.activeProjectId)!;
    const settings = await window.codepilot.getGlobalSettings();
    setState(next);
    setError("");
    setProjectDialog(undefined);
    if (settings.scaffold.mode === "guided") {
      setOnboardingMessage(`We just onboarded the ${source === "remote" ? "cloned" : "local"} Git repository for ${project.name}. Inspect the repository and existing PROJECT.md read-only, summarize its current architecture and maturity, identify missing context, then help me establish goals and a safe initial backlog. ${settings.scaffold.onboardingPrompt}`);
      setView("pm");
    } else setOnboardingMessage(undefined);
  }
  async function onboardLocal() {
    setProjectDialog(undefined); setOnboardingBusy("local"); setError("");
    try { const repo = await window.codepilot.selectDirectory(projectsDirectory); if (repo) await finishRepositoryOnboarding(await window.codepilot.onboardProject({ source: "local", repo }), "local"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setOnboardingBusy(""); }
  }
  async function onboardRemote() {
    const url = remoteUrl.trim(); if (!url) return;
    setOnboardingBusy("remote"); setError("");
    try { const next = await window.codepilot.onboardProject({ source: "remote", url }); setRemoteUrl(""); await finishRepositoryOnboarding(next, "remote"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setOnboardingBusy(""); }
  }
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
      <div className={`mt-auto rounded-xl border border-white/10 bg-white/[.03] ${sidebarCompact ? "p-2" : "p-4"}`}>{!sidebarCompact && <><div className="text-[10px] uppercase tracking-widest text-zinc-600">Active project</div><div className="mt-2 truncate text-sm font-medium">{active.name}</div><div className="mt-1 truncate font-mono text-[10px] text-zinc-600">{active.repo}</div></>}<div className={`${sidebarCompact ? "grid-cols-1" : "mt-4 grid-cols-2"} grid gap-2`}><button title="Open project folder" onClick={() => void window.codepilot.openProjectDirectory(active.id)} className="flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/[.04] px-2 py-2 text-xs text-zinc-300 hover:bg-white/[.08]"><FolderIcon className="size-4" />{!sidebarCompact && "Folder"}</button><button title={appStatus?.running ? "Stop project app" : "Start project app"} onClick={() => void (appStatus?.running ? window.codepilot.stopProjectApp(active.id) : window.codepilot.startProjectApp(active.id)).then(setAppStatus).catch(() => setView("runtime"))} className={`analog-control flex items-center justify-center gap-2 rounded-lg border px-2 py-2 text-xs ${appStatus?.running ? "analog-red" : "analog-green"}`}>{appStatus?.running ? <StopIcon className="size-4" /> : <PlayIcon className="size-4" />}{!sidebarCompact && (appStatus?.running ? "Stop" : "Start")}</button></div></div>
    </aside>
    <main className={`min-w-0 flex-1 ${view === "tasks" ? "overflow-hidden" : "overflow-y-auto"} ${view === "pm" && pmExpanded ? "p-4" : "p-10"}`}>
      <div data-pm-expanded={pmExpanded} className={`pm-shell relative ${view === "pm" ? "block" : "hidden"}`}>
        <PM key={active.id} projectId={active.id} initialMessage={onboardingMessage} triageMessage={triageMessage} triageTaskIds={triageTaskIds} visible={view === "pm"} projectName={active.name} expanded={pmExpanded} onExpand={() => setPMExpanded(value => !value)} />
      </div>
      {view === "pm" ? null : view === "tasks" ? <TaskBoard key={active.id} projectId={active.id} projectName={active.name} onTriage={triageTasks} onReviewProject={reviewProject} /> : view === "agents" ? <Agents key={active.id} projectId={active.id} onState={setState} /> : view === "active-agents" ? <ActiveAgents key={active.id} projectId={active.id} /> : view === "runtime" ? <AppControl key={active.id} projectId={active.id} status={appStatus} onStatus={setAppStatus} /> : view === "knowledge" ? <Knowledge key={active.id} projectId={active.id} /> : view === "project-settings" ? <ProjectSettings projectId={active.id} projectName={active.name}/> : view === "settings" ? <Settings state={state} onState={setState} /> : view === "projects" ? <>
        <div className="flex items-start justify-between gap-6"><Title eyebrow="Workspace registry" title="Projects" text={`Create, switch, or unregister projects under ${state.projectsDirectory}.`} /><button disabled={Boolean(onboardingBusy)} onClick={openProjectDialog} title="Add project" className="mt-1 flex items-center gap-2 rounded-xl border border-indigo-400/25 bg-indigo-400/10 px-3.5 py-2.5 text-sm font-semibold text-indigo-100 hover:bg-indigo-400/15 disabled:opacity-40"><PlusIcon className="size-5"/><span>Add project</span></button></div>
        <div className="mt-8 max-w-5xl space-y-3">
          {state.projects.map((project) => <div key={project.id} className={`flex overflow-hidden rounded-xl border ${project.id === active.id ? "border-indigo-400/30 bg-indigo-400/10" : "border-white/10 bg-white/[.025]"}`}><button onClick={() => {setOnboardingMessage(undefined);void switchProject(project.id)}} className="min-w-0 flex-1 p-5 text-left"><div className="flex items-center justify-between gap-4"><div className="font-medium">{project.name}</div>{Boolean(projectActivity[project.id])&&<span className="flex items-center gap-2 rounded-full bg-emerald-400/10 px-2.5 py-1 text-[10px] font-semibold uppercase text-emerald-300"><span className="size-1.5 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_7px_rgba(52,211,153,.7)]"/>{projectActivity[project.id]} working</span>}</div><div className="mt-2 truncate font-mono text-[10px] text-zinc-600">{project.repo}</div></button><button disabled={state.projects.length === 1} onClick={() => void removeProject(project.id, project.name)} title={state.projects.length === 1 ? "CodePilot needs at least one registered project" : "Remove from codePilot"} className="grid w-14 shrink-0 place-items-center border-l border-white/10 text-zinc-600 hover:bg-red-400/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-zinc-600"><TrashIcon className="size-4"/><span className="sr-only">Remove {project.name} from codePilot</span></button></div>)}
          {error && !projectDialog && <p className="rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-xs text-red-300">{error}</p>}
        </div>
      </> : <RunHistory state={state} projectId={active.id} />}
    </main>
    {projectDialog && <div role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" onMouseDown={(event) => {if(event.target===event.currentTarget&&!onboardingBusy)setProjectDialog(undefined)}} className="fixed inset-0 z-[90] grid place-items-center bg-zinc-950/75 p-6 backdrop-blur-sm"><section className="w-full max-w-2xl rounded-2xl border border-white/10 bg-zinc-950 p-6 shadow-2xl shadow-black/60"><div className="flex items-start justify-between gap-5"><div>{projectDialog!=="choose"&&<button onClick={()=>{setError("");setProjectDialog("choose")}} className="mb-3 flex items-center gap-1 text-xs text-zinc-500 hover:text-indigo-300"><ChevronLeftIcon className="size-3.5"/>All options</button>}<div className="text-[10px] font-semibold uppercase tracking-[.22em] text-indigo-400">Project registry</div><h2 id="project-dialog-title" className="mt-2 text-xl font-semibold">{projectDialog==="choose"?"Add a project":projectDialog==="github"?"Clone from GitHub":"Create a new project"}</h2><p className="mt-2 text-sm leading-6 text-zinc-500">{projectDialog==="choose"?"Choose how this project should enter your CodePilot workspace.":projectDialog==="github"?"Paste an HTTPS or SSH repository URL. Git's credential helper or SSH agent will handle access.":state.globalSettings.scaffold.mode==="guided"?"Name the project. CodePilot will create its Git repository and begin guided onboarding.":"Name the project. CodePilot will create a clean Git repository."}</p></div><button disabled={Boolean(onboardingBusy)} onClick={()=>setProjectDialog(undefined)} title="Close" className="rounded-lg p-2 text-zinc-600 hover:bg-white/5 hover:text-zinc-200 disabled:opacity-30"><XMarkIcon className="size-5"/></button></div>
      {projectDialog==="choose"?<div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-3"><button onClick={()=>void onboardLocal()} className="group rounded-2xl border border-white/10 bg-white/[.025] p-5 text-left hover:border-indigo-400/30 hover:bg-indigo-400/[.07]"><span className="grid size-11 place-items-center rounded-xl bg-indigo-400/10 text-indigo-300 group-hover:bg-indigo-400/15"><FolderIcon className="size-5"/></span><div className="mt-4 text-sm font-semibold">Local folder</div><p className="mt-1.5 text-xs leading-5 text-zinc-500">Select an existing local Git checkout.</p></button><button onClick={()=>{setError("");setProjectDialog("github")}} className="group rounded-2xl border border-white/10 bg-white/[.025] p-5 text-left hover:border-indigo-400/30 hover:bg-indigo-400/[.07]"><span className="grid size-11 place-items-center rounded-xl bg-indigo-400/10 text-indigo-300 group-hover:bg-indigo-400/15"><GitHubMark className="size-5"/></span><div className="mt-4 text-sm font-semibold">GitHub</div><p className="mt-1.5 text-xs leading-5 text-zinc-500">Clone an HTTPS or SSH Git repository.</p></button><button onClick={()=>{setError("");setProjectDialog("new")}} className="group rounded-2xl border border-white/10 bg-white/[.025] p-5 text-left hover:border-violet-400/30 hover:bg-violet-400/[.07]"><span className="grid size-11 place-items-center rounded-xl bg-violet-400/10 text-violet-300 group-hover:bg-violet-400/15"><PlusIcon className="size-5"/></span><div className="mt-4 text-sm font-semibold">New project</div><p className="mt-1.5 text-xs leading-5 text-zinc-500">Create a new Git project from scratch.</p></button></div>:projectDialog==="github"?<form onSubmit={(event)=>{event.preventDefault();if(remoteUrl.trim())void onboardRemote()}} className="mt-7"><label htmlFor="github-repository-url" className="text-xs font-medium text-zinc-300">Repository URL</label><input id="github-repository-url" autoFocus value={remoteUrl} onChange={(event)=>setRemoteUrl(event.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 font-mono text-xs outline-none focus:border-indigo-400/40" placeholder="https://github.com/owner/repository.git"/><p className="mt-2 text-[11px] text-zinc-600">Credentials must not be embedded in the URL.</p><button type="submit" disabled={!remoteUrl.trim()||Boolean(onboardingBusy)} className="mt-5 w-full rounded-xl bg-indigo-500 px-4 py-3 text-sm font-semibold hover:bg-indigo-400 disabled:opacity-40">{onboardingBusy==="remote"?"Cloning repository…":"Clone and onboard"}</button></form>:<form onSubmit={(event)=>{event.preventDefault();if(name.trim())void add()}} className="mt-7"><label htmlFor="new-project-name" className="text-xs font-medium text-zinc-300">Project name</label><input id="new-project-name" autoFocus value={name} onChange={(event)=>setName(event.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm outline-none focus:border-violet-400/40" placeholder="What should we call it?"/><p className="mt-2 truncate text-[11px] text-zinc-600">Created under {projectsDirectory}</p><button type="submit" disabled={!name.trim()||Boolean(onboardingBusy)} className="mt-5 w-full rounded-xl bg-violet-500 px-4 py-3 text-sm font-semibold hover:bg-violet-400 disabled:opacity-40">{state.globalSettings.scaffold.mode==="guided"?"Create and begin onboarding":"Create blank project"}</button></form>}
      {error&&<p className="mt-4 rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-xs text-red-300">{error}</p>}</section></div>}
    {projectTransition && <div className="pointer-events-none fixed inset-0 z-[80] grid place-items-center bg-zinc-950/45 backdrop-blur-[2px]"><div className="rounded-2xl border border-indigo-400/25 bg-zinc-950/95 px-8 py-6 text-center shadow-2xl"><div className="text-[10px] font-semibold uppercase tracking-[.24em] text-indigo-400">Switching project</div><div className="mt-3 flex items-center gap-3 text-sm text-zinc-200"><span className="max-w-40 truncate">{projectTransition.from}</span><span className="text-indigo-400">→</span><span className="max-w-40 truncate">{projectTransition.to}</span></div><p className="mt-3 text-[10px] text-zinc-500">Loading the selected project’s files, tasks, and sessions</p></div></div>}
  </div>;
}

function Nav({ active, on, icon, children }: { active: boolean; on(): void; icon: React.ReactNode; children: React.ReactNode }) { return <button title={typeof children === "string" ? children : "App Core"} onClick={on} className={`sidebar-nav flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${active ? "bg-white/10" : "text-zinc-500 hover:bg-white/5"}`}><span className="size-5 shrink-0">{icon}</span><span className="nav-label min-w-0 flex-1 text-left">{children}</span></button>; }
function RuntimeGlyph({ running }: { running: boolean }) { return <span className={`runtime-glyph ${running ? "runtime-glyph-on" : ""}`} aria-hidden="true"><span className="runtime-orbit" /><span className="runtime-core" /><span className="runtime-node runtime-node-a" /><span className="runtime-node runtime-node-b" /><span className="runtime-node runtime-node-c" /></span>; }
function GitHubMark({ className = "" }: { className?: string }) { return <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true"><path fillRule="evenodd" d="M12 2C6.477 2 2 6.596 2 12.267c0 4.537 2.865 8.385 6.839 9.744.5.094.682-.223.682-.495 0-.245-.009-1.054-.014-1.912-2.782.62-3.369-1.21-3.369-1.21-.455-1.187-1.11-1.502-1.11-1.502-.908-.637.069-.624.069-.624 1.004.073 1.532 1.058 1.532 1.058.892 1.568 2.341 1.115 2.91.853.091-.663.349-1.115.635-1.371-2.221-.26-4.556-1.14-4.556-5.075 0-1.121.39-2.037 1.029-2.756-.103-.259-.446-1.303.098-2.717 0 0 .84-.276 2.75 1.053A9.303 9.303 0 0 1 12 6.967a9.3 9.3 0 0 1 2.504.346c1.909-1.329 2.748-1.053 2.748-1.053.545 1.414.202 2.458.1 2.717.64.719 1.027 1.635 1.027 2.756 0 3.945-2.339 4.812-4.566 5.067.359.318.679.945.679 1.904 0 1.375-.012 2.482-.012 2.82 0 .275.18.594.688.493C19.138 20.385 22 16.537 22 12.267 22 6.596 17.523 2 12 2Z" clipRule="evenodd"/></svg>; }
function Title({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) { return <><div className="text-xs font-semibold uppercase tracking-[.2em] text-indigo-400">{eyebrow}</div><h1 className="mt-2 text-2xl font-semibold">{title}</h1><p className="mt-2 text-sm text-zinc-400">{text}</p></>; }
const rendererWindow = window as Window & { __codepilotRoot?: Root };
rendererWindow.__codepilotRoot ??= createRoot(document.getElementById("root")!);
rendererWindow.__codepilotRoot.render(<React.StrictMode><App /></React.StrictMode>);
