import { PaperAirplaneIcon, SparklesIcon } from "@heroicons/react/20/solid";
import { useEffect, useRef, useState } from "react";
import type { KnowledgeState } from "./types";
export function Knowledge() {
  const [state, setState] = useState<KnowledgeState>(),
    [input, setInput] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const chat = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void window.codepilot.getKnowledge().then(setState);
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (chat.current) chat.current.scrollTop = chat.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [state?.messages.length, busy]);
  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setBusy(true);
    setError("");
    setInput("");
    try {
      setState(await window.codepilot.chatKnowledge(message));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  if (!state) return <div className="text-zinc-500">Loading knowledge…</div>;
  return (
    <>
      <div className="text-xs font-semibold uppercase tracking-[.2em] text-indigo-400">
        Project intelligence
      </div>
      <h1 className="mt-2 text-2xl font-semibold">Knowledge curator</h1>
      <p className="mt-2 text-sm text-zinc-400">
        Talk to an AI that can explain, add, revise, publish, and remove durable
        project context.
      </p>
      <section className="mt-8 overflow-hidden rounded-2xl border border-indigo-400/20 bg-indigo-500/[.04]">
        <div className="flex items-center gap-3 border-b border-white/10 p-5">
          <span className="grid size-9 place-items-center rounded-xl bg-indigo-500">
            <SparklesIcon className="size-4" />
          </span>
          <div>
            <div className="text-sm font-semibold">AI project curator</div>
            <div className="text-xs text-zinc-500">
              Read-only model · validated desktop operations
            </div>
          </div>
        </div>
        <div ref={chat} className="h-96 space-y-4 overflow-y-auto p-6">
          {!state.messages.length && (
            <div className="grid h-full place-items-center text-sm text-zinc-600">
              Ask what the project knows, or tell me what context to add.
            </div>
          )}
          {state.messages.map((item, index) => (
            <div
              key={index}
              className={`flex ${item.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-6 ${item.role === "user" ? "bg-indigo-500" : "border border-white/10 bg-black/30 text-zinc-300"}`}
              >
                {item.content}
                {item.operations && (
                  <div className="mt-2 text-[10px] uppercase text-emerald-400">
                    {item.operations} change applied
                  </div>
                )}
              </div>
            </div>
          ))}
          {busy && (
            <div className="animate-pulse text-xs text-zinc-500">
              Curating knowledge…
            </div>
          )}
        </div>
        <div className="border-t border-white/10 p-4">
          <div className="flex gap-3">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              className="min-h-14 flex-1 resize-none rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm outline-none focus:border-indigo-500"
              placeholder="Add a convention, revise context, or ask a question…"
            />
            <button
              onClick={() => void send()}
              disabled={busy}
              className="w-14 rounded-xl bg-indigo-500 disabled:opacity-40"
            >
              <PaperAirplaneIcon className="mx-auto size-4" />
            </button>
          </div>
          {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
        </div>
      </section>
      <section className="mt-6 rounded-2xl border border-white/10 bg-white/[.025] p-6">
        <div className="flex justify-between">
          <h2 className="text-sm font-semibold">Durable context</h2>
          <span className="text-xs text-indigo-400">
            {state.entries.length} entries
          </span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          {state.entries.map((entry) => (
            <article
              key={entry.id}
              className="rounded-xl border border-white/10 bg-black/20 p-4"
            >
              <div className="font-medium">{entry.title}</div>
              <div className="mt-2 text-xs leading-5 text-zinc-500">
                {entry.content}
              </div>
              <div className="mt-3 text-[10px] text-emerald-400">
                {entry.published ? "AGENT VISIBLE" : "PRIVATE"}
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
