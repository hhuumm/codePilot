import { useEffect, useState } from "react";
import { BookOpenIcon } from "@heroicons/react/24/outline";
import type { AppStatus, ProjectBrief } from "./types";

export function ProjectSettings({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [brief, setBrief] = useState<ProjectBrief>();
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let mounted = true;
    Promise.all([window.codepilot.getProjectBrief(), window.codepilot.getAppStatus()]).then(([nextBrief, runtime]) => {
      if (!mounted) return;
      setBrief(nextBrief);
      setContent(withRunInstructions(nextBrief.content, runtime.config));
    });
    return () => { mounted = false; };
  }, [projectId]);
  async function save() {
    setBusy(true);
    try { const next = await window.codepilot.saveProjectBrief(content); setBrief(next); setContent(next.content); setSaved(true); window.setTimeout(() => setSaved(false), 1800); }
    finally { setBusy(false); }
  }
  return <div className="mx-auto max-w-5xl"><div className="text-xs font-semibold uppercase tracking-[.2em] text-indigo-400">Project README · {projectName}</div><div className="mt-2 flex items-center gap-3"><BookOpenIcon className="size-7 text-indigo-300" /><div><h1 className="text-2xl font-semibold">README</h1><p className="mt-1 text-sm text-zinc-400">User-facing documentation for running and understanding this project.</p></div></div><section className="mt-8 rounded-2xl border border-white/10 bg-white/[.025] p-6"><div className="flex items-start justify-between gap-5"><p className="text-xs text-zinc-600">{brief?.path ?? "Loading README path…"}</p><span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase ${brief?.exists ? "bg-emerald-400/10 text-emerald-300" : "bg-amber-400/10 text-amber-300"}`}>{brief?.exists ? "Tracked" : "Not created"}</span></div><textarea value={content} onChange={(event) => setContent(event.target.value)} rows={34} className="mt-6 w-full resize-y rounded-xl border border-white/10 bg-black/25 p-5 font-mono text-xs leading-6 text-zinc-300 outline-none focus:border-indigo-400/40" placeholder={'# Project name\n\n## Run locally\n\n## Purpose\n\n## Current architecture\n\n## Active work'} /><div className="mt-5 flex items-center justify-between"><p className="text-xs text-zinc-600">Run instructions are generated at the top; the remaining sections document the app and active project work.</p><div className="flex items-center gap-4">{saved && <span className="text-xs text-emerald-400">README saved.</span>}<button disabled={busy || !content.trim()} onClick={() => void save()} className="rounded-xl bg-indigo-500 px-5 py-2.5 text-sm font-semibold disabled:opacity-40">{busy ? "Saving…" : "Save README"}</button></div></div></section></div>;
}

function withRunInstructions(content: string, config: AppStatus["config"]): string {
  const marker = "## Run locally";
  if (content.includes(marker)) return content;
  const section = `${marker}\n\nFrom the project directory:\n\n\`\`\`bash\ncd ${config.workingDirectory || "."}\n${config.command || "# Configure a start command"}\n\`\`\`\n\nOpen the app at ${config.url || "the configured local URL"}.\n`;
  return `${section}\n${content.trimStart()}`.trim();
}
