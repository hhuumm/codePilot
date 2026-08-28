import React from "react";
export function EventView({
  timestamp,
  stream,
  payload,
}: {
  timestamp: string;
  stream: string;
  payload: unknown;
}) {
  const event = describe(payload, stream);
  if (!event) return null;
  return (
    <div
      className={`rounded-lg border p-3 ${event.tone === "error" ? "border-red-400/15 bg-red-400/5" : event.tone === "success" ? "border-emerald-400/30 bg-emerald-400/10" : event.tone === "action" ? "border-indigo-400/15 bg-indigo-400/5" : "border-white/5 bg-white/[.02]"}`}
    >
      <div className="flex items-center gap-3">
        <span className="text-[10px] text-zinc-700">
          {new Date(timestamp).toLocaleTimeString()}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          {event.label}
        </span>
      </div>
      <div
        className={`mt-2 whitespace-pre-wrap break-words text-xs leading-5 ${event.tone === "error" ? "text-red-300" : event.tone === "success" ? "text-emerald-300" : "text-zinc-300"}`}
      >
        {event.text}
      </div>
      {event.detail && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[10px] text-zinc-600">
            Show output
          </summary>
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-3 text-[10px] text-zinc-500">
            {event.detail}
          </pre>
        </details>
      )}
    </div>
  );
}
function describe(
  payload: unknown,
  stream: string,
):
  | {
      label: string;
      text: string;
      detail?: string;
      tone: "normal" | "action" | "success" | "error";
    }
  | undefined {
  if (typeof payload === "string")
    return {
      label: stream === "stderr" ? "Error" : "Output",
      text: payload,
      tone: stream === "stderr" ? "error" : "normal",
    };
  if (!payload || typeof payload !== "object") return;
  const root = payload as Record<string, unknown>,
    type = String(root.type ?? "event"),
    item =
      root.item && typeof root.item === "object"
        ? (root.item as Record<string, unknown>)
        : undefined;
  if (type === "thread.started")
    return { label: "Session", text: "Agent session started", tone: "normal" };
  if (type === "turn.started")
    return {
      label: "Thinking",
      text: "Agent began working on the task",
      tone: "normal",
    };
  if (type === "turn.completed") {
    const usage = root.usage as Record<string, unknown> | undefined;
    return {
      label: "Finished",
      text: usage
        ? `Agent turn completed · ${Number(usage.output_tokens ?? 0).toLocaleString()} output tokens`
        : "Agent turn completed",
      tone: "normal",
    };
  }
  if (item) {
    const itemType = String(item.type ?? "item"),
      status = String(item.status ?? "");
    if (itemType === "agent_message")
      return {
        label: "Agent",
        text: String(item.text ?? item.content ?? "Agent update"),
        tone: "action",
      };
    if (itemType === "command_execution") {
      const output = String(item.aggregated_output ?? "").trim(),
        failed =
          item.exit_code !== undefined &&
          item.exit_code !== null &&
          item.exit_code !== 0;
      return {
        label:
          status === "in_progress"
            ? "Running"
            : failed
              ? "Command failed"
              : "Command passed",
        text: cleanCommand(String(item.command ?? "command")),
        ...(output ? { detail: output } : {}),
        tone: failed
          ? "error"
          : status === "in_progress"
            ? "normal"
            : "success",
      };
    }
    if (itemType === "file_change") {
      const changes = Array.isArray(item.changes)
        ? (item.changes as Array<Record<string, unknown>>)
        : [];
      return {
        label:
          status === "in_progress"
            ? "Editing"
            : status === "failed"
              ? "Edit failed"
              : "Files changed",
        text:
          changes
            .map(
              (change) =>
                `${String(change.kind ?? "change")} ${shortPath(String(change.path ?? "file"))}`,
            )
            .join("\n") || "Updating files",
        tone: status === "failed" ? "error" : "action",
      };
    }
  }
  return {
    label: type.replace(/[._]/g, " "),
    text: JSON.stringify(payload),
    tone: stream === "stderr" ? "error" : "normal",
  };
}
function shortPath(path: string) {
  const marker = path.toLowerCase().lastIndexOf("\\.codepilot\\w\\");
  if (marker < 0) return path;
  const parts = path.slice(marker + 1).split("\\");
  return parts.slice(4).join("\\") || path;
}
function cleanCommand(command: string) {
  const match = command.match(/-Command\s+(.+)$/s),
    value = (match?.[1] ?? command).replace(/^['"]|['"]$/g, "");
  return value.length > 220 ? `${value.slice(0, 220)}…` : value;
}

type TimelineEvent = { timestamp: string; stream: string; payload: unknown };
export function collapseLifecycleEvents(
  events: TimelineEvent[],
): TimelineEvent[] {
  const collapsed: TimelineEvent[] = [];
  const positions = new Map<string, number>();
  let session = 0;
  for (const event of events) {
    const root =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : undefined;
    if (root?.type === "thread.started") session += 1;
    const item =
      root?.item && typeof root.item === "object"
        ? (root.item as Record<string, unknown>)
        : undefined;
    const id =
      typeof item?.id === "string" ? `${session}:${item.id}` : undefined;
    if (id && positions.has(id)) collapsed[positions.get(id)!] = event;
    else {
      if (id) positions.set(id, collapsed.length);
      collapsed.push(event);
    }
  }
  return collapsed;
}
