import React, { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, FolderOpenIcon, StopCircleIcon } from "@heroicons/react/24/outline";
import type { ActiveAgent } from "./types";
import { collapseLifecycleEvents, EventView } from "./event-view";

export function ActiveAgents() {
  const [agents, setAgents] = useState<ActiveAgent[]>([]),
    [expanded, setExpanded] = useState<Set<string>>(new Set()),
    [messages, setMessages] = useState<Record<string, string>>({}),
    [sending, setSending] = useState(""),
    [interrupting, setInterrupting] = useState(""),
    [feedback, setFeedback] = useState(""),
    [error, setError] = useState("");
  const seen = useRef(new Set<string>()),
    logs = useRef(new Map<string, HTMLDivElement>());
  async function refresh() {
    try {
      const next = await window.codepilot.getActiveAgents();
      setAgents(next);
      setExpanded((current) => {
        const copy = new Set(current);
        for (const agent of next)
          if (!seen.current.has(agent.taskId)) {
            seen.current.add(agent.taskId);
            copy.add(agent.taskId);
          }
        return copy;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1200);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      for (const [taskId, element] of logs.current)
        if (expanded.has(taskId)) element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [agents, expanded]);
  function toggle(id: string) {
    setExpanded((current) => {
      const copy = new Set(current);
      copy.has(id) ? copy.delete(id) : copy.add(id);
      return copy;
    });
  }
  async function guide(agent: ActiveAgent) {
    const message = messages[agent.taskId]?.trim();
    if (!message) return;
    setSending(agent.taskId);
    setError("");
    try {
      setAgents(await window.codepilot.guideAgent(agent.taskId, message));
      setMessages((current) => ({ ...current, [agent.taskId]: "" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending("");
    }
  }
  async function interrupt(agent: ActiveAgent) {
    setInterrupting(agent.taskId);
    setError("");
    try {
      const result = await window.codepilot.interruptAgent(agent.taskId);
      setFeedback(result.feedback);
      setAgents(result.agents);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInterrupting("");
    }
  }
  return (
    <div className="mx-auto max-w-6xl">
      <div className="text-xs font-semibold uppercase tracking-[.2em] text-indigo-400">
        Live operations
      </div>
      <div className="mt-2 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Active agents</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Expand multiple workers to compare their progress and logs
            concurrently.
          </p>
        </div>
        <div className="flex gap-2">
            <button onClick={() => void window.codepilot.openProjectDirectory()} className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300 hover:bg-white/5"><FolderOpenIcon className="size-4" />Open project folder</button>
          {agents.length > 1 && <>
            <button
              onClick={() =>
                setExpanded(new Set(agents.map((agent) => agent.taskId)))
              }
              className="rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-400"
            >
              Expand all
            </button>
            <button
              onClick={() => setExpanded(new Set())}
              className="rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-400"
            >
              Collapse all
            </button>
          </>}
        </div>
      </div>
      {error && (
        <p className="mt-5 rounded-lg border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-300">
          {error}
        </p>
      )}
      {feedback && <div className="mt-5 flex items-start justify-between gap-4 rounded-xl border border-amber-400/20 bg-amber-400/10 p-4 text-sm text-amber-200"><span>{feedback}</span><button onClick={() => setFeedback("")} className="text-xs text-amber-300/70 hover:text-amber-200">Dismiss</button></div>}
      {!agents.length ? (
        <div className="mt-8 rounded-2xl border border-dashed border-white/10 py-24 text-center">
          <div className="text-sm text-zinc-400">
            No agents are currently working.
          </div>
          <div className="mt-2 text-xs text-zinc-600">
            Completed results are available from Overview.
          </div>
        </div>
      ) : (
        <div className="mt-8 space-y-4">
          {agents.map((agent) => {
            const open = expanded.has(agent.taskId);
            return (
              <section
                key={agent.taskId}
                className="overflow-hidden rounded-2xl border border-white/10 bg-white/[.025]"
              >
                <button
                  onClick={() => toggle(agent.taskId)}
                  className="flex w-full items-center gap-4 p-5 text-left"
                >
                  <ChevronDownIcon
                    className={`size-4 shrink-0 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}
                  />
                  <span className="rounded-md bg-indigo-500/15 px-2 py-1 text-xs font-semibold uppercase text-indigo-300">
                    {agent.provider}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {agent.objective}
                  </span>
                  {agent.pendingGuidance > 0 && (
                    <span className="text-[10px] text-amber-300">
                      {agent.pendingGuidance} queued
                    </span>
                  )}
                  <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-emerald-400">
                    <i className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
                    working
                  </span>
                </button>
                {open && (
                  <div className="border-t border-white/10">
                    <div
                      ref={(element) => {
                        if (element) logs.current.set(agent.taskId, element);
                        else logs.current.delete(agent.taskId);
                      }}
                      className="agent-log max-h-[360px] min-h-44 space-y-3 overflow-x-auto overflow-y-scroll bg-black/20 p-5 pr-3"
                    >
                      {agent.events.length ? (
                        collapseLifecycleEvents(agent.events).map(
                          (event, index) => (
                            <EventView
                              key={`${event.timestamp}-${index}`}
                              {...event}
                            />
                          ),
                        )
                      ) : (
                        <div className="text-xs text-zinc-600">
                          Waiting for the first agent update…
                        </div>
                      )}
                    </div>
                    <div className="border-t border-white/10 p-4">
                      <div className="mb-3 flex justify-end"><button disabled={interrupting === agent.taskId} onClick={() => void interrupt(agent)} className="flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-400/15 disabled:opacity-50"><StopCircleIcon className="size-4" />{interrupting === agent.taskId ? "Stopping…" : "Interrupt & hand off"}</button></div>
                      <div className="flex gap-3">
                        <textarea
                          value={messages[agent.taskId] ?? ""}
                          onChange={(event) =>
                            setMessages((current) => ({
                              ...current,
                              [agent.taskId]: event.target.value,
                            }))
                          }
                          rows={2}
                          placeholder={`Chime in with ${agent.provider}…`}
                          className="min-w-0 flex-1 resize-none rounded-xl border border-white/10 bg-black/20 p-3 text-sm outline-none focus:border-indigo-400/50"
                        />
                        <button
                          disabled={
                            sending === agent.taskId ||
                            !messages[agent.taskId]?.trim()
                          }
                          onClick={() => void guide(agent)}
                          className="rounded-xl bg-indigo-500 px-5 text-sm font-semibold disabled:opacity-50"
                        >
                          {sending === agent.taskId ? "Sending…" : "Chime in"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
