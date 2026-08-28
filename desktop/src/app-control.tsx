import { ArrowPathIcon, ArrowTopRightOnSquareIcon, PlayIcon, StopIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import type { AppConfig, AppStatus } from "./types";

export function AppControl({ projectId, status, onStatus }: { projectId: string; status?: AppStatus; onStatus(status: AppStatus): void }) {
  const [config, setConfig] = useState<AppConfig>({ command: "", workingDirectory: ".", url: "http://localhost:3000" });
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [previewKey, setPreviewKey] = useState(0);
  const loaded = useRef(false);
  useEffect(() => {
    loaded.current = false;
  }, [projectId]);
  useEffect(() => { if (status && !loaded.current) { setConfig(status.config); loaded.current = true; } }, [status]);
  async function act(name: string, action: () => Promise<AppStatus>) {
    setBusy(name); setMessage("");
    try { const next = await action(); onStatus(next); setConfig(next.config); setMessage(name === "save" ? "Configuration saved." : ""); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(""); }
  }
  return <div className="mx-auto max-w-5xl">
    <div className="text-xs font-semibold uppercase tracking-[.2em] text-indigo-400">Project runtime</div>
    <div className="mt-3 flex items-center gap-4"><span className={`runtime-glyph runtime-glyph-large ${status?.running ? "runtime-glyph-on" : ""}`} aria-hidden="true"><span className="runtime-orbit" /><span className="runtime-core" /><span className="runtime-node runtime-node-a" /><span className="runtime-node runtime-node-b" /><span className="runtime-node runtime-node-c" /></span><div><div className="flex items-baseline gap-3"><h1 className="font-mono text-2xl font-semibold tracking-wide">APP CORE</h1><span className={`font-mono text-sm font-semibold tracking-[.22em] ${status?.running ? "text-emerald-300" : "text-zinc-600"}`}>// {status?.running ? "ON" : "OFF"}</span></div><div className={`mt-1 flex items-center gap-1 ${status?.running ? "text-emerald-400/60" : "text-zinc-700"}`} aria-hidden="true"><span className="core-signal h-1" /><span className="core-signal h-2" /><span className="core-signal h-3" /><span className="core-signal h-1.5" /><span className="ml-2 font-mono text-[9px] tracking-widest">{status?.running ? "PROCESS LINK ACTIVE" : "PROCESS LINK DORMANT"}</span></div></div></div>
    <p className="mt-2 text-sm text-zinc-400">Configure how codePilot launches this project. The PM can update these values when you ask it to configure the app.</p>
    {config.url && status?.running && <section className="mt-8 overflow-hidden rounded-2xl border border-white/10 bg-white/[.025]">
      <header className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-4">
        <div className="min-w-0"><h2 className="text-sm font-semibold">Live preview</h2><p className="mt-1 truncate font-mono text-[10px] text-zinc-600">{config.url}</p></div>
        <button onClick={() => setPreviewKey(value => value + 1)} className="flex shrink-0 items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300 hover:bg-white/5"><ArrowPathIcon className="size-3.5"/>Refresh</button>
      </header>
      <iframe key={`${config.url}-${previewKey}`} src={config.url} title="Project application preview" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-pointer-lock" referrerPolicy="no-referrer" className="h-[680px] w-full border-0 bg-zinc-950"/>
    </section>}
    <div className="mt-8 grid grid-cols-[minmax(0,1fr)_minmax(320px,.8fr)] gap-6">
      <section className="rounded-2xl border border-white/10 bg-white/[.025] p-6">
        <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Launch configuration</h2><span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase ${status?.running ? "bg-emerald-400/10 text-emerald-300" : "bg-zinc-400/10 text-zinc-500"}`}>{status?.running ? `Running · ${status.pid}` : "Stopped"}</span></div>
        <Label text="Start command"><input value={config.command} onChange={(event) => setConfig({ ...config, command: event.target.value })} placeholder="npm start" className="field" /></Label>
        <Label text="Working directory"><input value={config.workingDirectory} onChange={(event) => setConfig({ ...config, workingDirectory: event.target.value })} placeholder="." className="field" /></Label>
        <Label text="App URL"><div className="flex gap-2"><input value={config.url} onChange={(event) => setConfig({ ...config, url: event.target.value })} placeholder="http://localhost:3000" className="field min-w-0 flex-1" /><button disabled={Boolean(busy) || !config.url} onClick={() => void act("clear-port", () => window.codepilot.clearProjectPort(projectId))} className="flex shrink-0 items-center gap-1 rounded-lg border border-amber-400/20 px-3 text-xs text-amber-300 hover:bg-amber-400/10 disabled:opacity-40"><XMarkIcon className="size-3.5" />Clear port</button></div></Label>
        {message && <p className="mt-4 text-xs text-amber-300">{message}</p>}
        <div className="mt-6 flex flex-wrap gap-3">
          <button disabled={Boolean(busy)} onClick={() => void act("save", () => window.codepilot.saveAppConfig(projectId, config))} className="rounded-lg border border-white/10 px-4 py-2.5 text-sm text-zinc-300 hover:bg-white/5 disabled:opacity-50">Save configuration</button>
          <button disabled={Boolean(busy)} onClick={() => void (status?.running ? act("stop", () => window.codepilot.stopProjectApp(projectId)) : act("start", () => window.codepilot.startProjectApp(projectId)))} className={`analog-control flex items-center gap-2 rounded-lg border px-5 py-2.5 text-sm font-semibold transition disabled:opacity-40 ${status?.running ? "analog-red" : "analog-green"}`}>{status?.running ? <StopIcon className="size-4" /> : <PlayIcon className="size-4" />}{busy ? "Working…" : status?.running ? "Stop app" : "Start app"}</button>
          <button disabled={!config.url} onClick={() => void window.codepilot.openProjectApp(projectId)} className="flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2.5 text-sm text-zinc-300 disabled:opacity-40"><ArrowTopRightOnSquareIcon className="size-4" />Open app</button>
        </div>
      </section>
      <section className="flex min-h-96 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[.025]"><header className="border-b border-white/10 p-5 text-sm font-semibold">App output</header><pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap bg-black/20 p-5 text-[11px] leading-5 text-zinc-500">{status?.logs.length ? status.logs.join("") : "Start the app to see its output here."}</pre></section>
    </div>
  </div>;
}

function Label({ text, children }: { text: string; children: React.ReactNode }) { return <label className="mt-5 block"><span className="text-xs font-medium text-zinc-400">{text}</span><div className="mt-2">{children}</div></label>; }
