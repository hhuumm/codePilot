import { ArchiveBoxIcon, ChevronDownIcon, ChevronUpIcon, ClockIcon, ExclamationTriangleIcon, PlayCircleIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState } from "react";
import { EventView } from "./event-view";
import type { PMState, PMTask, PMTaskDetail } from "./types";

type Column = { title: string; subtitle: string; tone: string; icon: typeof ClockIcon; tasks: PMTask[] };

export function TaskBoard({ projectId, projectName, onTriage, onReviewProject }: { projectId: string; projectName: string; onTriage(tasks: PMTask[]): void; onReviewProject(): void }) {
  const [state, setState] = useState<PMState>();
  const [selected, setSelected] = useState<PMTaskDetail>();
  const [loading, setLoading] = useState("");
  const [allTasksOpen, setAllTasksOpen] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [expandedTaskIds, setExpandedTaskIds] = useState<string[]>([]);
  const [context, setContext] = useState<{ task: PMTask; x: number; y: number }>();
  const [requeueingColumn, setRequeueingColumn] = useState("");
  const [runningReady, setRunningReady] = useState(false);
  const commitTaskBin = window.codepilot.commitPMTaskBin;
  useEffect(() => {
    let active = true;
    const refresh = () => void window.codepilot.getPM().then((next) => active && setState(next));
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [projectId]);
  useEffect(() => setExpandedTaskIds([]), [projectId]);

  const allTasks = state?.tasks ?? [];
  const tasks = allTasks.filter((task) => task.status !== "committed");
  const columns = useMemo<Column[]>(() => {
    const failed = (task: PMTask) => ["failed", "needs_review"].includes(task.lastRunStatus ?? "");
    return [
      { title: "Backlog", subtitle: "Manual, unprioritized work", tone: "text-violet-400", icon: ArchiveBoxIcon, tasks: tasks.filter((task) => task.status === "backlog" && !failed(task)) },
      { title: "Blocked", subtitle: "Waiting on prerequisites", tone: "text-zinc-400", icon: ClockIcon, tasks: tasks.filter((task) => task.status === "blocked" && !failed(task)) },
      { title: "Ready", subtitle: "Eligible for dispatch", tone: "text-sky-400", icon: PlayCircleIcon, tasks: tasks.filter((task) => task.status === "ready" && !failed(task) && task.lastRunStatus !== "completed") },
      { title: "Failed", subtitle: "Failed or needs review", tone: "text-amber-400", icon: ExclamationTriangleIcon, tasks: tasks.filter((task) => ["failed", "needs_review"].includes(task.lastRunStatus ?? "")) },
    ];
  }, [tasks]);
  async function requeueAll(column: Column) {
    if (!column.tasks.length || requeueingColumn) return;
    setRequeueingColumn(column.title);
    try {
      for (const task of column.tasks)
        await window.codepilot.setPMTaskStatus(task.id, "ready", `Requeued from the ${column.title} task-board column.`);
      setState(await window.codepilot.getPM());
    } finally {
      setRequeueingColumn("");
    }
  }
  async function refreshBlockers() {
    if (requeueingColumn) return;
    setRequeueingColumn("Blocked");
    try {
      setState(await window.codepilot.getPM());
    } finally {
      setRequeueingColumn("");
    }
  }
  async function runAllReady(readyTasks: PMTask[]) {
    if (!readyTasks.length || runningReady) return;
    setRunningReady(true);
    try {
      for (const task of readyTasks)
        setState(await window.codepilot.setPMTaskStatus(task.id, "launched"));
      const result = await window.codepilot.runAgentBatch({
        objective: `Task Board coordinated delivery batch (${readyTasks.length} tasks)`,
        items: readyTasks.map((task) => ({
          id: task.id,
          objective: `${task.title}\n\ncodePilot PM task: ${task.id}\nQueue: ${task.queueTitle}\n\n${task.description}\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
          provider: task.recommendedProvider === "claude" ? "claude" : "codex",
        })),
        retries: 0,
        timeoutMinutes: 30,
        validationCommands: [],
        integrate: true,
        dryRun: false,
      });
      const summary = result.review.findings.length ? result.review.findings.join(" ") : `Coordinated batch completed with review verdict: ${result.review.verdict}.`;
      for (const task of readyTasks)
        setState(result.status === "completed"
          ? await window.codepilot.setPMTaskStatus(task.id, "done", summary)
          : await window.codepilot.recordPMTaskFailure(task.id, summary));
      setState(await window.codepilot.getPM());
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      for (const task of readyTasks)
        try {
          setState(await window.codepilot.recordPMTaskFailure(task.id, `Coordinated batch failed before delivery: ${reason}`));
        } catch {}
    } finally {
      setRunningReady(false);
    }
  }

  return <div className="flex h-full min-h-0 flex-col" onClick={() => context && setContext(undefined)}>
    <div className="text-xs font-semibold uppercase tracking-[.2em] text-indigo-400">Project planning</div>
    <div className="mt-2 flex items-center justify-between gap-4"><div className="flex items-center gap-3"><h1 className="text-2xl font-semibold">Suggested tasks</h1><button onClick={onReviewProject} className="rounded-lg border border-violet-400/30 bg-violet-400/10 px-3 py-2 text-xs font-semibold text-violet-200 hover:bg-violet-400/15">Review</button></div><button disabled={!selectedTaskIds.length || Boolean(commitMessage)} onClick={async () => { setCommitMessage("Committing…"); try {
      if (typeof commitTaskBin !== "function") throw new Error("The desktop bridge is out of date. Restart codePilot, then try the commit again.");
      const bin = await commitTaskBin(selectedTaskIds);
      setCommitMessage(`Bin ${bin.hash} · commit ${bin.commit.slice(0, 8)}`);
      setState(await window.codepilot.getPM());
      if (selected && bin.taskIds.includes(selected.task.id)) setSelected(undefined);
      setSelectedTaskIds([]);
    } catch (cause) { setCommitMessage(cause instanceof Error ? cause.message : String(cause)); } finally { window.setTimeout(() => setCommitMessage(""), 5000); } }} className="rounded-lg border border-indigo-400/30 bg-indigo-400/10 px-3 py-2 text-xs font-semibold text-indigo-200 disabled:cursor-not-allowed disabled:opacity-40">Commit selected tasks</button></div>
    <p className="mt-2 text-sm text-zinc-400">Backlog work stays manual; dependency-aware queues release ready tasks only after every prerequisite is complete.</p>
    <div className="mt-8 min-h-0 flex-1 grid grid-cols-4 gap-4 overflow-hidden">
      {columns.map((column) => <section key={column.title} className="flex min-w-0 flex-col self-start rounded-2xl border border-white/10 bg-white/[.025]">
        <header className="flex items-start justify-between border-b border-white/10 p-5">
          <div className="flex min-w-0 gap-3"><column.icon className={`mt-0.5 size-5 shrink-0 ${column.tone}`} /><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold">{column.title}</h2>{column.title === "Ready" ? <button disabled={!column.tasks.length || runningReady} onClick={() => void runAllReady(column.tasks)} className="rounded-md border border-sky-400/20 bg-sky-400/[.07] px-2 py-1 text-[9px] font-semibold text-sky-300 hover:border-sky-400/40 hover:bg-sky-400/15 disabled:cursor-not-allowed disabled:opacity-35">{runningReady ? "Running…" : "Run all"}</button> : <>{column.title !== "Failed" && <button disabled={!column.tasks.length || Boolean(requeueingColumn)} onClick={() => column.title === "Blocked" ? void refreshBlockers() : void requeueAll(column)} className="rounded-md border border-white/10 px-2 py-1 text-[9px] font-semibold text-zinc-400 hover:border-indigo-400/30 hover:bg-indigo-400/10 hover:text-indigo-200 disabled:cursor-not-allowed disabled:opacity-35">{requeueingColumn === column.title ? (column.title === "Blocked" ? "Checking…" : "Requeueing…") : (column.title === "Blocked" ? "Check blockers" : "Requeue all")}</button>}{column.title === "Failed" && <button disabled={!column.tasks.length} onClick={() => onTriage(column.tasks)} className="rounded-md border border-violet-400/20 bg-violet-400/[.07] px-2 py-1 text-[9px] font-semibold text-violet-300 hover:border-violet-400/40 hover:bg-violet-400/15 disabled:cursor-not-allowed disabled:opacity-35">Re-triage all with PM</button>}</>}</div><p className="mt-1 truncate text-xs text-zinc-500">{column.subtitle}</p></div></div>
          <span className="rounded-full bg-white/[.07] px-2.5 py-1 text-xs font-medium text-zinc-300">{column.tasks.length}</span>
        </header>
        <div className="h-[312px] min-h-0 w-full flex-none space-y-2 overflow-y-auto overscroll-contain p-3 [scrollbar-gutter:stable]">
          {column.tasks.map((task) => <TaskCard key={task.id} task={task} expanded={expandedTaskIds.includes(task.id)} loading={loading === task.id} dependencyTitles={task.dependencies.map((id) => allTasks.find((candidate) => candidate.id === id)?.title ?? id)} onContext={(event) => { event.preventDefault(); event.stopPropagation(); setContext({ task, x: event.clientX, y: event.clientY }); }} onToggle={() => setExpandedTaskIds((ids) => ids.includes(task.id) ? ids.filter((id) => id !== task.id) : [...ids, task.id])} onOpen={async () => { setLoading(task.id); try { setSelected(await window.codepilot.getPMTaskDetail(task.id)); } finally { setLoading(""); } }} />)}
          {!column.tasks.length && <div className="grid h-32 place-items-center rounded-xl border border-dashed border-white/10 text-xs text-zinc-600">No tasks here</div>}
        </div>
      </section>)}
    </div>
    {commitMessage && <p className="mt-2 text-xs text-zinc-400">{commitMessage}</p>}
    <AllTasksView tasks={tasks} open={allTasksOpen} setOpen={setAllTasksOpen} selectedTaskIds={selectedTaskIds} setSelectedTaskIds={setSelectedTaskIds} onSelect={async (task) => { setLoading(task.id); try { setSelected(await window.codepilot.getPMTaskDetail(task.id)); } finally { setLoading(""); } }} />
    {selected && <TaskDrawer detail={selected} close={() => setSelected(undefined)} revise={async () => { setState(await window.codepilot.setPMTaskStatus(selected.task.id, "ready", "Marked for revision after review.")); setSelected(undefined); }} />}
    {context && <TaskContextMenu task={context.task} x={context.x} y={context.y} close={() => setContext(undefined)} onState={setState} onTriage={(task) => onTriage([task])} />}
  </div>;
}

function AllTasksView({ tasks, open, setOpen, selectedTaskIds, setSelectedTaskIds, onSelect }: { tasks: PMTask[]; open: boolean; setOpen(open: boolean): void; selectedTaskIds: string[]; setSelectedTaskIds(ids: string[]): void; onSelect(task: PMTask): void }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [priority, setPriority] = useState("all");
  const [queue, setQueue] = useState("all");
  const [timeRange, setTimeRange] = useState("all");
  const queues = [...new Set(tasks.map((task) => task.queueTitle).filter(Boolean))].sort();
  const now = Date.now();
  const age = (task: PMTask) => now - new Date(task.updatedAt || task.createdAt).getTime();
  const filtered = tasks.filter((task) => {
    const haystack = `${task.title} ${task.description} ${task.queueTitle}`.toLowerCase();
    return (!query.trim() || haystack.includes(query.trim().toLowerCase())) &&
      (status === "all" || task.status === status) &&
      (priority === "all" || task.priority === priority) &&
      (queue === "all" || task.queueTitle === queue) &&
      (timeRange === "all" ||
        (timeRange === "recent" && age(task) <= 6 * 60 * 60 * 1000) ||
        (timeRange === "today" && age(task) <= 24 * 60 * 60 * 1000) ||
        (timeRange === "week" && age(task) <= 7 * 24 * 60 * 60 * 1000) ||
        (timeRange === "month" && age(task) <= 30 * 24 * 60 * 60 * 1000) ||
        (timeRange === "older" && age(task) > 30 * 24 * 60 * 60 * 1000));
  });
  return <section className={`mt-4 min-h-0 flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[.025] ${open ? "flex-1" : "flex-none"}`}>
    <button onClick={() => setOpen(!open)} className="flex items-center justify-between border-b border-white/10 px-5 py-4 text-left hover:bg-white/[.03]"><div><h2 className="text-sm font-semibold">All tasks</h2><p className="mt-1 text-xs text-zinc-500">Alternate list view for the full task history and backlog</p></div><span className="rounded-full bg-white/[.07] px-3 py-1 text-xs text-zinc-400">{open ? "Collapse" : `${tasks.length} tasks · Expand`}</span></button>
    {open && <>
      <div className="grid shrink-0 grid-cols-5 gap-2 border-b border-white/10 p-3"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter tasks…" className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs outline-none focus:border-indigo-400/40" /><Filter value={status} onChange={setStatus} options={["all", "backlog", "blocked", "ready", "launched", "done"]} /><Filter value={priority} onChange={setPriority} options={["all", "high", "medium", "low"]} /><Filter value={queue} onChange={setQueue} options={["all", ...queues]} /><Filter value={timeRange} onChange={setTimeRange} labels={{ all: "All time", recent: "Recent · 6 hours", today: "Today", week: "Last 7 days", month: "Last 30 days", older: "Older" }} options={["all", "recent", "today", "week", "month", "older"]} /></div>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"><div className="divide-y divide-white/5">{filtered.map((task) => <div key={task.id} className="grid w-full grid-cols-[28px_minmax(0,1fr)_100px_80px_150px] items-center gap-4 px-5 py-3 hover:bg-white/[.03]"><input type="checkbox" checked={selectedTaskIds.includes(task.id)} onChange={() => setSelectedTaskIds(selectedTaskIds.includes(task.id) ? selectedTaskIds.filter((id) => id !== task.id) : [...selectedTaskIds, task.id])} className="accent-indigo-400" aria-label={`Include ${task.title} in commit bin`} /><button onClick={() => onSelect(task)} className="min-w-0 text-left"><span className="block truncate text-xs font-medium text-zinc-200">{task.title}</span><span className="mt-1 block truncate text-[10px] text-zinc-600">{task.description || "No description"}</span></button><span className="text-[10px] uppercase text-zinc-500">{task.status}</span><span className="text-[10px] uppercase text-zinc-500">{task.priority}</span><span className="truncate text-[10px] text-zinc-600">{task.queueTitle}</span></div>)}{!filtered.length && <div className="py-12 text-center text-xs text-zinc-600">No tasks match these filters.</div>}</div></div>
    </>}
  </section>;
}

function Filter({ value, onChange, options, labels }: { value: string; onChange(value: string): void; options: string[]; labels?: Record<string, string> }) { return <select value={value} onChange={(event) => onChange(event.target.value)} style={{ colorScheme: "dark" }} className="rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-xs capitalize text-zinc-200 outline-none focus:border-indigo-400/40">{options.map((option) => <option className="bg-zinc-900 text-zinc-200" key={option} value={option}>{labels?.[option] ?? (option === "all" ? "All" : option.replace("_", " "))}</option>)}</select>; }

function TaskCard({ task, expanded, loading, dependencyTitles, onToggle, onOpen, onContext }: { task: PMTask; expanded: boolean; loading: boolean; dependencyTitles: string[]; onToggle(): void; onOpen(): void; onContext(event: React.MouseEvent): void }) {
  const runLabel = task.lastRunStatus?.replace("_", " ") ?? "not run";
  if (!expanded) return <button type="button" aria-expanded="false" onContextMenu={onContext} onClick={onToggle} className="group flex min-h-11 w-full items-center gap-2 rounded-lg border border-white/10 bg-zinc-950/70 px-3 py-2 text-left shadow-sm transition hover:border-indigo-400/30 hover:bg-white/[.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60">
    <span className={`size-1.5 shrink-0 rounded-full ${task.priority === "high" ? "bg-red-400" : task.priority === "medium" ? "bg-amber-400" : "bg-zinc-500"}`} />
    <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-zinc-200">{task.title}</span>
    <span className="shrink-0 text-[8px] font-semibold uppercase tracking-wide text-zinc-600">{loading ? "loading…" : runLabel}</span>
    <ChevronDownIcon className="size-3.5 shrink-0 text-zinc-600 transition group-hover:text-indigo-300" />
  </button>;
  return <div onContextMenu={onContext} className="relative overflow-hidden rounded-lg border border-indigo-400/25 bg-zinc-950/80 shadow-sm ring-1 ring-indigo-400/5">
    <button type="button" aria-label={`Collapse ${task.title}`} onClick={onToggle} className="absolute right-2 top-2 z-10 rounded-md p-1 text-zinc-600 hover:bg-white/[.06] hover:text-indigo-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"><ChevronUpIcon className="size-3.5" /></button>
    <button type="button" aria-expanded="true" onClick={onOpen} className="w-full p-3 pr-8 text-left transition hover:bg-white/[.035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400/60">
    <div className="flex items-center justify-between gap-2"><span className="rounded-md bg-indigo-400/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-indigo-300">{task.priority}</span><span className="text-[9px] uppercase tracking-wide text-zinc-600">{loading ? "loading…" : runLabel}</span></div>
    <div className="mt-2 text-[8px] font-semibold uppercase tracking-[.14em] text-indigo-400/70">{task.queueTitle}</div><h3 className="mt-1 text-xs font-medium leading-4 text-zinc-100">{task.title}</h3>
    {task.description && <p className="mt-1 line-clamp-3 text-[10px] leading-4 text-zinc-500">{task.description}</p>}
    {task.summary && <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-emerald-300/70">{task.summary}</p>}
    {task.status === "blocked" && dependencyTitles.length > 0 && <p className="mt-1 text-[9px] leading-3 text-amber-300/70">Blocked by: {dependencyTitles.join(", ")}</p>}
    <div className="mt-2 flex items-center justify-between border-t border-white/5 pt-2 text-[9px] text-zinc-600"><span>{task.acceptanceCriteria.length} acceptance {task.acceptanceCriteria.length === 1 ? "check" : "checks"}</span><span>Details →</span></div>
    </button>
  </div>;
}

function TaskDrawer({ detail, close, revise }: { detail: PMTaskDetail; close(): void; revise(): Promise<void> }) {
  const { task, run } = detail;
  return <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><aside className="h-full w-full max-w-2xl overflow-y-auto border-l border-white/10 bg-zinc-950 p-7 shadow-2xl">
    <header className="flex items-start justify-between gap-5"><div><div className="text-xs font-semibold uppercase tracking-[.18em] text-indigo-400">Task details</div><h2 className="mt-2 text-xl font-semibold">{task.title}</h2></div><div className="flex items-center gap-2"><button onClick={() => void revise()} className="rounded-lg border border-indigo-400/25 px-3 py-2 text-xs font-semibold text-indigo-200 hover:bg-indigo-400/10">Revise task</button><button onClick={close} className="rounded-lg border border-white/10 p-2 text-zinc-500 hover:bg-white/5 hover:text-white"><XMarkIcon className="size-5" /></button></div></header>
    <div className="mt-5 flex flex-wrap gap-2"><Pill value={task.status} /><Pill value={task.queueTitle} /><Pill value={task.priority} /><Pill value={task.recommendedProvider ?? "either"} />{run && <Pill value={run.status} />}</div>
    <section className="mt-7 rounded-2xl border border-white/10 bg-white/[.025] p-5"><h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Description</h3><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-zinc-300">{task.description || "No description provided."}</p><h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-zinc-500">Acceptance criteria</h3>{task.acceptanceCriteria.length ? <ol className="mt-3 space-y-2">{task.acceptanceCriteria.map((item, index) => <li key={`${item}-${index}`} className="flex gap-3 text-sm leading-6 text-zinc-300"><span className="text-indigo-400">{index + 1}.</span>{item}</li>)}</ol> : <p className="mt-3 text-sm text-zinc-600">No acceptance criteria.</p>}</section>
    {detail.prerequisites.length > 0 && <section className="mt-5 rounded-2xl border border-amber-400/15 bg-amber-400/[.04] p-5"><h3 className="text-xs font-semibold uppercase tracking-wider text-amber-300/70">Prerequisites</h3><div className="mt-3 space-y-2">{detail.prerequisites.map((prerequisite) => <div key={prerequisite.id} className="flex items-center justify-between gap-4 text-sm text-zinc-300"><span>{prerequisite.title}</span><Pill value={prerequisite.status} /></div>)}</div></section>}
    {run && <section className="mt-5 rounded-2xl border border-white/10 bg-white/[.025] p-5"><div className="flex justify-between gap-4"><div><h3 className="text-sm font-semibold">Latest execution</h3><p className="mt-1 font-mono text-[10px] text-zinc-600">{run.id}</p></div><span className="text-xs text-zinc-500">{new Date(run.updatedAt).toLocaleString()}</span></div>{detail.workers.length > 0 && <div className="mt-4 flex flex-wrap gap-2">{detail.workers.map((worker) => <span key={worker.taskId} className="rounded-lg bg-black/30 px-3 py-2 text-xs text-zinc-400"><span className="capitalize text-zinc-200">{worker.provider}</span> · {worker.status}</span>)}</div>}</section>}
    <section className="mt-5"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Recent task logs</h3><span className="text-xs text-zinc-600">{detail.events.length} events</span></div><div className="mt-3 space-y-2">{detail.events.length ? detail.events.map((event, index) => <EventView key={`${event.timestamp}-${index}`} {...event} />) : <div className="rounded-xl border border-dashed border-white/10 py-12 text-center text-sm text-zinc-600">This task has no execution logs yet.</div>}</div></section>
  </aside></div>;
}

function Pill({ value }: { value: string }) { return <span className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">{value.replace("_", " ")}</span>; }

function TaskContextMenu({ task, x, y, close, onState, onTriage }: { task: PMTask; x: number; y: number; close(): void; onState(state: PMState): void; onTriage(task: PMTask): void }) {
  const api = window.codepilot as typeof window.codepilot & { deletePMTask: (id: string) => Promise<PMState> };
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (busy) close(); }, [busy]);
  async function requeue() { setBusy(true); try { onState(await window.codepilot.setPMTaskStatus(task.id, "ready", "Requeued manually from the task board.")); close(); } finally { setBusy(false); } }
  function triage() { close(); onTriage(task); }
  async function remove() { if (!confirm(`Delete task “${task.title}”?`)) return; setBusy(true); try { onState(await api.deletePMTask(task.id)); close(); } finally { setBusy(false); } }
  async function run() { setBusy(true); try { onState(await window.codepilot.setPMTaskStatus(task.id, "launched")); const result = await window.codepilot.runAgents({ objective: `${task.title}\n\n${task.description}\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`, providers: [task.recommendedProvider === "claude" ? "claude" : "codex"], retries: 0, timeoutMinutes: 30, validationCommands: [], integrate: true, dryRun: false }); const summary = result.review.findings.length ? result.review.findings.join(" ") : `Agent run completed with review verdict: ${result.review.verdict}.`; onState(result.status === "completed" ? await window.codepilot.setPMTaskStatus(task.id, "done", summary) : await window.codepilot.recordPMTaskFailure(task.id, summary)); close(); } catch (cause) { const reason = cause instanceof Error ? cause.message : String(cause); try { onState(await window.codepilot.recordPMTaskFailure(task.id, `Task did not advance because the run failed: ${reason}`)); } catch {} close(); } finally { setBusy(false); } }
  return <div onClick={(event) => event.stopPropagation()} style={{ left: Math.min(x, window.innerWidth - 190), top: Math.min(y, window.innerHeight - 130) }} className="fixed z-[70] w-44 overflow-hidden rounded-xl border border-white/10 bg-zinc-900 py-1 shadow-2xl ring-1 ring-black/50">{["ready", "backlog"].includes(task.status) && <button disabled={busy} onClick={() => void run()} className="w-full px-3 py-2 text-left text-xs text-indigo-200 hover:bg-indigo-500/15 disabled:opacity-40">Run task</button>}<button disabled={busy} onClick={triage} className="w-full px-3 py-2 text-left text-xs text-violet-200 hover:bg-violet-500/15 disabled:opacity-40">Triage in PM</button><button disabled={busy} onClick={() => void requeue()} className="w-full px-3 py-2 text-left text-xs text-zinc-200 hover:bg-indigo-500/15 disabled:opacity-40">Requeue task</button><button disabled={busy} onClick={() => void remove()} className="w-full px-3 py-2 text-left text-xs text-rose-300 hover:bg-rose-500/15 disabled:opacity-40">Delete task</button></div>;
}
