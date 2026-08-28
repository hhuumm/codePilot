import React, { useEffect, useRef, useState } from "react";
import {
  ArrowsPointingOutIcon,
  PaperAirplaneIcon,
  PlayIcon,
  ArrowsPointingInIcon,
} from "@heroicons/react/24/outline";
import type { PMState, PMTask } from "./types";
export function PM({ projectId, initialMessage, triageMessage, triageTaskIds = [], visible, projectName, expanded, onExpand }: { projectId: string; initialMessage?: string; triageMessage?: string; triageTaskIds?: string[]; visible: boolean; projectName: string; expanded?: boolean; onExpand?: () => void }) {
  const [state, setState] = useState<PMState>(),
    [message, setMessage] = useState(""),
    [queue, setQueue] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [launching, setLaunching] = useState<Set<string>>(() => new Set()),
    [dispatchedTaskIds, setDispatchedTaskIds] = useState<Set<string>>(() => new Set()),
    [triagedTaskIds, setTriagedTaskIds] = useState<Set<string>>(() => new Set()),
    [error, setError] = useState("");
  const processing = useRef(false), onboardingStarted = useRef(false),
    lastTriageMessage = useRef<string | undefined>(undefined),
    dispatchedTaskIdsRef = useRef<Set<string>>(new Set()),
    autonomousReviewQueued = useRef(false),
    chat = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void window.codepilot.getPM(projectId).then(setState);
  }, [projectId]);
  useEffect(() => { if (initialMessage && !onboardingStarted.current) { onboardingStarted.current = true; setQueue([initialMessage]); } }, [initialMessage]);
  useEffect(() => {
    if (!triageMessage || triageMessage === lastTriageMessage.current) return;
    lastTriageMessage.current = triageMessage;
    setQueue((items) => [...items, triageMessage]);
  }, [triageMessage]);
  useEffect(() => {
    if (triageTaskIds.length) setTriagedTaskIds((ids) => new Set([...ids, ...triageTaskIds]));
  }, [triageTaskIds]);
  useEffect(() => {
    if (processing.current || !queue.length) return;
    const next = queue[0]!;
    processing.current = true;
    setBusy(true);
    void window.codepilot
      .chatPM(projectId, next)
      .then(async (nextState) => {
        setState(nextState);
        const settings = await window.codepilot.getGlobalSettings();
        if ((settings.scaffold?.autoDeploy ?? true) && !nextState.requiresUserInput)
          for (const task of nextState.tasks.filter((item) => item.status === "ready" && !dispatchedTaskIdsRef.current.has(item.id)))
            await launch(task, settings.defaultProvider);
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => {
        setQueue((items) => items.slice(1));
        setBusy(false);
        processing.current = false;
        if (next.startsWith("What's next?")) autonomousReviewQueued.current = false;
      });
  }, [queue]);
  useEffect(() => {
    if (!visible) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => { if (chat.current) chat.current.scrollTop = chat.current.scrollHeight; }); });
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
  }, [visible, state?.messages.length, queue, busy]);
  function submit() {
    const value = message.trim();
    if (!value) return;
    setQueue((items) => [...items, value]);
    setMessage("");
    setError("");
  }
  function queueAutonomousReview(reason: string) {
    if (autonomousReviewQueued.current) return;
    autonomousReviewQueued.current = true;
    setQueue((items) => [...items, `What's next? Continue the project autonomously. Triage the latest task outcomes and current repository state, then add or update the next concrete implementation, repair, verification, documentation, or completion tasks. Dispatch-safe assumptions are preferred over questions. Ask for user input only if work truly cannot continue without an organic decision or hands-on user testing.\n\nLatest cycle: ${reason}\n\nAutonomous review: ${new Date().toISOString()}`]);
  }
  async function clear() {
    if (
      !confirm("Clear this PM conversation? Your backlog tasks will be kept.")
    )
      return;
    setQueue([]);
    setState(await window.codepilot.clearPMChat(projectId));
  }
  async function launch(task: PMTask, provider: "codex" | "claude") {
    if (dispatchedTaskIdsRef.current.has(task.id)) return;
    const restoreForTriage = () => {
      dispatchedTaskIdsRef.current.delete(task.id);
      setDispatchedTaskIds((items) => { const next = new Set(items); next.delete(task.id); return next; });
      setTriagedTaskIds((items) => { const next = new Set(items); next.delete(task.id); return next; });
    };
    dispatchedTaskIdsRef.current.add(task.id);
    setLaunching((items) => new Set(items).add(task.id));
    setDispatchedTaskIds((items) => new Set(items).add(task.id));
    setError("");
    try {
      setState(await window.codepilot.setPMTaskStatus(projectId, task.id, "launched"));
      void window.codepilot
        .runAgents({
          projectId,
          objective: `${task.title}\n\ncodePilot PM task: ${task.id}\nQueue: ${task.queueTitle}\n\n${task.description}\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
          providers: [provider],
          retries: 0,
          timeoutMinutes: 30,
          validationCommands: [],
          integrate: true,
          dryRun: false,
        })
        .then(async (result) => {
          if (result.status === "completed") {
            const summary = result.review.findings.length ? result.review.findings.join(" ") : `Agent run completed with review verdict: ${result.review.verdict}.`;
            const nextState = await window.codepilot.setPMTaskStatus(projectId, task.id, "done", summary);
            setState(nextState);
            const settings = await window.codepilot.getGlobalSettings();
            const readyTasks = nextState.tasks.filter((item) => item.status === "ready" && !dispatchedTaskIdsRef.current.has(item.id));
            if (settings.scaffold?.autoDeploy ?? true)
              for (const ready of readyTasks)
                await launch(ready, settings.defaultProvider);
            if (!readyTasks.length) queueAutonomousReview(`Completed "${task.title}". ${summary}`);
          } else {
            const reason = result.review.findings.length ? result.review.findings.join(" ") : `The agent run returned ${result.status} with review verdict ${result.review.verdict}.`;
            setState(await window.codepilot.recordPMTaskFailure(projectId, task.id, `Task did not advance because it was not eligible for completion: ${reason}`));
            restoreForTriage();
            queueAutonomousReview(`"${task.title}" needs re-triage after ${result.status}: ${reason}`);
            setError(
              `Run finished as ${result.status}; the recommendation remains actionable.`,
            );
          }
        })
        .catch(async (cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
          setState(await window.codepilot.recordPMTaskFailure(projectId, task.id, `Task did not advance because the agent run failed: ${cause instanceof Error ? cause.message : String(cause)}`));
          restoreForTriage();
          queueAutonomousReview(`"${task.title}" failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        })
        .finally(() => setLaunching((items) => { const next = new Set(items); next.delete(task.id); return next; }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      try { setState(await window.codepilot.recordPMTaskFailure(projectId, task.id, `Task did not advance because launch failed: ${cause instanceof Error ? cause.message : String(cause)}`)); } catch {}
      restoreForTriage();
      queueAutonomousReview(`"${task.title}" could not launch: ${cause instanceof Error ? cause.message : String(cause)}`);
      setLaunching((items) => { const next = new Set(items); next.delete(task.id); return next; });
    }
  }
  async function requeueTask(task: PMTask) {
    setState(await window.codepilot.setPMTaskStatus(projectId, task.id, "ready", "Requeued from the Project Manager recent work list."));
    setTriagedTaskIds((items) => { const next = new Set(items); next.delete(task.id); return next; });
    setDispatchedTaskIds((items) => { const next = new Set(items); next.delete(task.id); return next; });
    dispatchedTaskIdsRef.current.delete(task.id);
  }
  function discussTask(task: PMTask) {
    setTriagedTaskIds((ids) => new Set(ids).add(task.id));
    const failures = (task.failures ?? []).slice(-5).map((failure, index) => `${index + 1}. ${failure.timestamp}: ${failure.summary}`).join("\n");
    setQueue((items) => [...items, `Let's discuss the current state of task "${task.title}" and decide what should happen next.${failures ? `\n\nRecent failure history:\n${failures}` : ""}`]);
  }
  if (!state)
    return (
      <div className="grid h-full place-items-center text-sm text-zinc-500">
        Loading PM workspace…
      </div>
    );
  const suggestedTasks: PMTask[] = state.tasks
    .filter((task) => !dispatchedTaskIds.has(task.id) && !["launched", "done", "committed"].includes(task.status) && task.lastRunStatus !== "completed")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);
  const taskTitles = new Map(state.tasks.map((task) => [task.id, task.title]));
  const taskQueues = [...suggestedTasks.reduce((groups, task) => {
    const group = groups.get(task.queueId) ?? { id: task.queueId, title: task.queueTitle, tasks: [] as PMTask[] };
    group.tasks.push(task);
    groups.set(task.queueId, group);
    return groups;
  }, new Map<string, { id: string; title: string; tasks: PMTask[] }>()).values()];
  return (
    <div className="mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)_390px] gap-6">
      <section className="flex min-h-[780px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[.025]">
        <header className="flex items-start justify-between border-b border-white/10 p-6">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[.2em] text-indigo-400">
              Planning partner
            </div>
            <h1 className="mt-2 text-2xl font-semibold">Project Manager</h1>
            <p className="mt-2 text-sm text-zinc-400">
              Ready tasks deploy automatically; dependent work waits for its prerequisites.
            </p>
          </div>
          <button onClick={onExpand} className="rounded-lg border border-white/10 p-2 text-zinc-500 hover:bg-white/5 hover:text-indigo-300" title={expanded ? "Restore chat" : "Expand chat"}>{expanded ? <ArrowsPointingInIcon className="size-4" /> : <ArrowsPointingOutIcon className="size-4" />}</button>
        </header>
        <div
          ref={chat}
          className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6"
        >
          {state.messages.length ? (
            state.messages.map((item, index) => (
              <Bubble
                key={`${item.timestamp}-${index}`}
                role={item.role}
                content={item.content}
                operations={item.operations}
              />
            ))
          ) : (
            <div className="rounded-xl border border-dashed border-white/10 p-6 text-sm leading-6 text-zinc-500">
              Start with the outcome you want, a problem you’re weighing, or ask
              what the project should tackle next.
            </div>
          )}
          {queue.map((content, index) => (
            <div
              key={`${content}-${index}`}
              className="flex justify-end opacity-60"
            >
              <div className="max-w-[82%] rounded-2xl border border-indigo-400/20 bg-indigo-500/20 px-4 py-3 text-sm text-zinc-300">
                <div className="whitespace-pre-wrap">{content}</div>
                <div className="mt-2 text-[10px] uppercase tracking-wider text-indigo-300">
                  {index === 0 && busy ? "PM is thinking" : "Queued"}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-white/10 p-5">
          <div className="flex gap-3">
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              rows={3}
              placeholder={
                busy
                  ? "Add another message to the queue…"
                  : "Let’s discuss the next milestone…"
              }
              className="min-w-0 flex-1 resize-none rounded-xl border border-white/10 bg-black/20 p-3 text-sm outline-none focus:border-indigo-400/50"
            />
            <button
              disabled={!message.trim()}
              onClick={submit}
              className="self-stretch rounded-xl bg-indigo-500 px-5 disabled:opacity-50"
            >
              <PaperAirplaneIcon className="size-5" />
            </button>
          </div>
          {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
        </div>
      </section>
      <aside className="flex h-[780px] min-h-0 flex-col">
        <div className="mb-4 flex items-end justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[.2em] text-indigo-400">
              Recent incomplete tasks
            </div>
            <h2 className="mt-2 text-lg font-semibold">Recent work</h2>
            <p className="mt-1 text-[10px] text-zinc-600">Open tasks from this project</p>
          </div>
          <span className="text-xs text-zinc-600">{suggestedTasks.length}</span>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable]">
          {taskQueues.length ? (
            taskQueues.map((taskQueue) => (
              <section key={taskQueue.id} className="rounded-2xl border border-white/10 bg-white/[.015] p-3">
                <div className="mb-3 flex items-center justify-between px-2 pt-1">
                  <div><div className="text-[10px] font-semibold uppercase tracking-[.16em] text-indigo-300">{taskQueue.title}</div><div className="mt-1 text-[10px] text-zinc-600">{taskQueue.tasks.filter((task) => task.status === "ready").length} ready · {taskQueue.tasks.filter((task) => task.status === "blocked").length} blocked</div></div>
                  <span className="rounded-full bg-white/[.06] px-2 py-1 text-[10px] text-zinc-500">{taskQueue.tasks.length}</span>
                </div>
                <div className="space-y-3">{taskQueue.tasks.map((task) => (
                  <TaskCard key={task.id} task={task} launching={launching.has(task.id)} projectName={projectName} triaged={triagedTaskIds.has(task.id) || Boolean(task.failures?.length && !["failed", "needs_review"].includes(task.lastRunStatus ?? ""))} dependencyTitles={task.dependencies.map((id) => taskTitles.get(id) ?? id)} launch={launch} requeue={requeueTask} discuss={discussTask} />
                ))}</div>
              </section>
            ))
          ) : (
            <div className="rounded-2xl border border-dashed border-white/10 p-6 text-center text-xs leading-5 text-zinc-600">
              Queued work has moved to the Task Board.
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
function Bubble({
  role,
  content,
  operations,
}: {
  role: "user" | "assistant";
  content: string;
  operations?: number;
}) {
  return (
    <div
      className={`flex ${role === "user" ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`max-w-[82%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 ${role === "user" ? "bg-indigo-500 text-white" : "border border-white/10 bg-white/5 text-zinc-300"}`}
      >
        {content}
        {operations && (
          <div className="mt-2 text-[10px] uppercase tracking-wider opacity-50">
            Backlog updated · {operations}
          </div>
        )}
      </div>
    </div>
  );
}
function TaskCard({
  task,
  launching,
  projectName,
  dependencyTitles,
  launch,
  requeue,
  discuss,
  triaged,
}: {
  task: PMTask;
  launching: boolean;
  projectName: string;
  dependencyTitles: string[];
  launch(task: PMTask, provider: "codex" | "claude"): void;
  requeue(task: PMTask): void;
  discuss(task: PMTask): void;
  triaged: boolean;
}) {
  const recommended = task.recommendedProvider ?? "either",
    rerun = task.status === "done",
    launchable = task.status === "ready" || task.status === "done";
  return (
    <div className="relative rounded-xl border border-white/10 bg-white/[.025] p-3">
      <div className="flex items-center justify-between gap-3">
        <span
          className={`rounded-md px-2 py-1 text-[10px] uppercase tracking-wider ${task.priority === "high" ? "bg-red-400/10 text-red-300" : task.priority === "medium" ? "bg-amber-400/10 text-amber-300" : "bg-zinc-400/10 text-zinc-400"}`}
        >
          {task.priority}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-zinc-600">
          {task.status}
        </span>
      </div>
      <h3 className="mt-2 text-xs font-semibold">{task.title}</h3>
      <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-zinc-400">{task.summary || task.description}</p>
      {task.status === "blocked" && dependencyTitles.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-400/15 bg-amber-400/[.06] px-3 py-2 text-[10px] leading-4 text-amber-200/80">Blocked by: {dependencyTitles.join(", ")}</div>
      )}
      {false && task.acceptanceCriteria.length > 0 && (
        <div className="mt-3 space-y-1">
          {task.acceptanceCriteria.map((item) => (
            <div key={item} className="text-[11px] leading-4 text-zinc-600">
              ✓ {item}
            </div>
          ))}
        </div>
      )}
      <div className="hidden">
        PM recommends {recommended}
      </div>
      {false && rerun && (
        <p className="mt-2 text-[10px] text-zinc-600">
          Uses the active project’s latest commit in a fresh checkout.
        </p>
      )}
      <div className="mt-3 flex items-center justify-between text-[10px] uppercase tracking-wider text-zinc-600"><span>{task.queueTitle}</span><span>PM · {recommended}</span></div>
      <div className="hidden"> <button onClick={() => discuss(task)}>Discuss</button><button onClick={() => void requeue(task)}>Requeue</button></div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          disabled={triaged || launching || !launchable}
          onClick={() => discuss(task)}
          className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50 ${recommended === "codex" || recommended === "either" ? "bg-indigo-500" : "border border-white/10 text-zinc-300"}`}
        >
          <PlayIcon className="size-3" />
          {triaged ? "Triaged" : "Triage"}
        </button>
        <button
          disabled={triaged || launching || !launchable}
          onClick={() => launch(task, recommended === "claude" ? "claude" : "codex")}
          className={`rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50 ${recommended === "claude" ? "bg-indigo-500" : "border border-white/10 text-zinc-300"}`}
        >
          Run
        </button>
      </div>
    </div>
  );
}
