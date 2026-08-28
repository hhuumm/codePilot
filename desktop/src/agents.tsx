import React, { useEffect, useState } from "react";
import { PlayIcon } from "@heroicons/react/24/outline";
import type { AgentRunResult, DesktopState, PMState, PMTask } from "./types";
export function Agents({ onState }: { onState(state: DesktopState): void }) {
  const [objective, setObjective] = useState(""),
    [codex, setCodex] = useState(true),
    [claude, setClaude] = useState(false),
    [validation, setValidation] = useState(""),
    [integrate, setIntegrate] = useState(true),
    [createPullRequest, setCreatePullRequest] = useState(false),
    [dryRun, setDryRun] = useState(false),
    [running, setRunning] = useState(0),
    [error, setError] = useState(""),
    [results, setResults] = useState<AgentRunResult[]>([]);
  const [pmState, setPMState] = useState<PMState>();
  const [showAllTasks, setShowAllTasks] = useState(false);
  const [poofing, setPoofing] = useState<Set<string>>(() => new Set());
  useEffect(() => { void window.codepilot.getGlobalSettings().then((settings) => { setCodex(settings.defaultProvider === "codex"); setClaude(settings.defaultProvider === "claude"); }); }, []);
  useEffect(() => { let active = true; const refresh = () => void window.codepilot.getPM().then((next) => active && setPMState(next)); refresh(); const timer = window.setInterval(refresh, 2000); return () => { active = false; window.clearInterval(timer); }; }, []);
  async function deployTask(task: PMTask) { setError(""); try { setPMState(await window.codepilot.setPMTaskStatus(task.id, "launched")); setPoofing((items) => new Set(items).add(task.id)); await new Promise((resolve) => window.setTimeout(resolve, 900)); const result = await window.codepilot.runAgents({ objective: `${task.title}\n\ncodePilot PM task: ${task.id}\n\n${task.description}\n\nAcceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`, providers: [task.recommendedProvider === "claude" ? "claude" : "codex"], retries: 0, timeoutMinutes: 30, validationCommands: [], integrate, createPullRequest, dryRun }); setResults((current) => [result, ...current].slice(0, 5)); const nextStatus = result.status === "completed" ? "done" : "ready"; const summary = result.review.findings.length ? result.review.findings.join(" ") : `Task did not advance because the agent run returned ${result.status} with review verdict ${result.review.verdict}.`; setPMState(await window.codepilot.setPMTaskStatus(task.id, nextStatus, summary)); } catch (cause) { const reason = cause instanceof Error ? cause.message : String(cause); setError(reason); try { setPMState(await window.codepilot.setPMTaskStatus(task.id, "ready", `Task did not advance because deployment failed: ${reason}`)); } catch {} } finally { setPoofing((items) => { const next = new Set(items); next.delete(task.id); return next; }); } }
  async function launch() {
    const requestObjective = objective.trim();
    if (!requestObjective) return;
    setError("");
    setObjective("");
    setValidation("");
    try {
      const [title, ...rest] = requestObjective.split(/\r?\n/);
      const nextPM = await window.codepilot.createPMTask({ title: title.slice(0, 160), description: `${rest.join("\n").trim() || title}${validation.trim() ? `\n\nVerification criteria:\n${validation.trim()}` : ""}`, acceptanceCriteria: validation.split("\n").map((item) => item.trim()).filter(Boolean), recommendedProvider: codex ? "codex" : "claude" });
      setPMState(nextPM);
      const created = [...nextPM.tasks].reverse().find((task) => task.title === title.slice(0, 160));
      if (created) void deployTask(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      onState(await window.codepilot.getState());
    }
  }
  return (
    <div className="mx-auto max-w-5xl">
      <div className="text-xs font-semibold uppercase tracking-[.2em] text-indigo-400">
        Execution workspace
      </div>
      <h1 className="mt-2 text-2xl font-semibold">Deploy</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Assign work to coding agents in isolated Git worktrees. Published
        project knowledge is included automatically.
      </p>
      <div className="mt-8 grid grid-cols-[1fr_300px] gap-6">
        <section className="rounded-2xl border border-white/10 bg-white/[.025] p-6">
          <label className="text-sm font-medium">
            What should the agents accomplish?
          </label>
          <textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            rows={8}
            placeholder="Implement a focused change, test it, and explain any tradeoffs…"
            className="mt-3 w-full resize-y rounded-xl border border-white/10 bg-black/20 p-4 text-sm outline-none focus:border-indigo-400/50"
          />
          <label className="mt-6 block text-sm font-medium">
            Verification criteria{" "}
            <span className="font-normal text-zinc-600">
              (plain language, one per line)
            </span>
          </label>
          <textarea
            value={validation}
            onChange={(e) => setValidation(e.target.value)}
            rows={3}
            placeholder={"Confirm the chat returns grounded API answers\nRun the project test suite\nVerify no secrets are exposed"}
            className="mt-3 w-full rounded-xl border border-white/10 bg-black/20 p-4 font-mono text-xs outline-none focus:border-indigo-400/50"
          />
          <button
            disabled={!objective.trim() || (!codex && !claude)}
            onClick={() => void launch()}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-500 px-4 py-3 text-sm font-semibold disabled:cursor-wait disabled:opacity-60"
          >
            <PlayIcon className="size-4" />
            Add task to deploy board
          </button>
          {error && (
            <p className="mt-4 rounded-lg border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-300">
              {error}
            </p>
          )}
          {results.map((result) => (
            <div
              key={result.runId}
              className="mt-4 rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm"
            >
              <div className="font-semibold text-emerald-300">
                Run {result.status}
              </div>
              <div className="mt-1 text-zinc-400">
                Review: {result.review.verdict}
                {result.integrationBranch
                  ? ` · ${result.integrationBranch}`
                  : ""}
              </div>
              {result.review.findings.map((item) => (
                <div key={item} className="mt-2 text-xs text-zinc-400">
                  • {item}
                </div>
              ))}
              {result.pullRequestUrl && <a href={result.pullRequestUrl} target="_blank" rel="noreferrer" className="mt-3 block text-xs font-semibold text-indigo-300 hover:text-indigo-200">Open pull request →</a>}
            </div>
          ))}
        </section>
        <aside className="space-y-4">
          <Panel title="Agent providers">
            <Check label="Codex" checked={codex} set={setCodex} />
            <Check label="Claude" checked={claude} set={setClaude} />
          </Panel>
          <Panel title="Delivery policy">
            <Check
              label="Create integration branch"
              checked={integrate}
              set={setIntegrate}
            />
            <Check
              label="Create GitHub pull request"
              checked={createPullRequest}
              set={(value) => { setCreatePullRequest(value); if (value) { setIntegrate(true); setDryRun(false); } }}
            />
            <Check label="Dry run only" checked={dryRun} set={setDryRun} />
            <p className="mt-3 text-xs leading-5 text-zinc-600">
              Agents never edit your current checkout. Eligible commits are
              assembled on a separate codepilot branch.
            </p>
          </Panel>
        </aside>
      </div>
      {false && <section className="mt-6 rounded-2xl border border-white/10 bg-white/[.025] p-6">
        {(() => { const available = (pmState?.tasks ?? []).filter((task) => !["done", "committed", "launched"].includes(task.status)); const visible = showAllTasks ? available : available.slice(0, 3); return <><div className="flex items-center justify-between"><div><h2 className="text-sm font-semibold">Deploy board</h2><p className="mt-1 text-xs text-zinc-500">Open work from the PM and the main form.</p></div><span className="text-xs text-zinc-500">{available.length} open</span></div><div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{visible.map((task) => <div key={task.id} className={`flex min-h-36 flex-col rounded-xl border border-white/10 bg-black/20 p-4 ${poofing.has(task.id) ? "task-poof" : ""}`}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="line-clamp-2 text-xs font-medium text-zinc-200">{task.title}</div><div className="mt-2 line-clamp-3 text-[10px] leading-4 text-zinc-600">{task.description}</div></div><span className="shrink-0 rounded-md bg-white/5 px-2 py-1 text-[9px] uppercase text-zinc-500">{task.status}</span></div><div className="mt-auto pt-4">{["ready", "backlog"].includes(task.status) && <button onClick={() => void deployTask(task)} className="w-full rounded-lg bg-indigo-500 px-3 py-2 text-xs font-semibold">Deploy task</button>}</div></div>)}{!available.length && <p className="col-span-full py-8 text-center text-xs text-zinc-600">No open tasks.</p>}</div>{available.length > 3 && <button onClick={() => setShowAllTasks((value) => !value)} className="mt-4 w-full rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-400 hover:bg-white/[.03]">{showAllTasks ? "Show fewer tasks" : `Expand board · ${available.length - 3} more`}</button>}</> })()}
      </section>}
    </div>
  );
}
function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[.025] p-5">
      <h2 className="mb-4 text-sm font-semibold">{title}</h2>
      {children}
    </div>
  );
}
function Check({
  label,
  checked,
  set,
}: {
  label: string;
  checked: boolean;
  set(value: boolean): void;
}) {
  return (
    <label className="mb-3 flex cursor-pointer items-center justify-between text-sm text-zinc-300">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => set(e.target.checked)}
        className="size-4 accent-indigo-500"
      />
    </label>
  );
}
