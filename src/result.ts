import { readFile } from "node:fs/promises";
import type { AgentTask, WorkerReport } from "./domain.js";

export function checkoutInstructions(task: AgentTask): string {
  if (!task.coordinationRepo || !task.checkoutCommand) return "";
  const leaseSeconds = Math.ceil((task.checkoutLeaseMs ?? 30 * 60_000) / 1_000);
  const priority = task.checkoutPriority ?? 50;
  return `Cooperative file checkout is required. Before editing any file, acquire all files you expect to edit atomically and wait if another worker owns them. This worker has coordination priority ${priority}; higher-priority workers retry sooner, while contenders back off exponentially (250ms, 500ms, 1s, up to 5s):
${task.checkoutCommand} checkout acquire --repo ${JSON.stringify(task.coordinationRepo)} --owner ${task.id} --priority ${priority} --wait ${leaseSeconds} --lease ${leaseSeconds} -- <project-relative paths...>
If the set changes, acquire the additional paths before editing them. Release paths when finished with:
${task.checkoutCommand} checkout release --repo ${JSON.stringify(task.coordinationRepo)} --owner ${task.id} -- <project-relative paths...>
Your remaining checkouts are released automatically when this task exits. Do not edit a file unless this task owns its checkout.`;
}

const outcomes = new Set(["completed", "partial", "blocked", "failed"]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseReport(value: unknown): WorkerReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 0 ||
    typeof candidate.status !== "string" ||
    !outcomes.has(candidate.status) ||
    typeof candidate.summary !== "string" ||
    !isStringArray(candidate.claimedTests) ||
    !isStringArray(candidate.concerns) ||
    !isStringArray(candidate.followUps) ||
    (candidate.artifacts !== undefined && !isStringArray(candidate.artifacts)) ||
    (candidate.noChangeReason !== undefined &&
      (typeof candidate.noChangeReason !== "string" || !candidate.noChangeReason.trim()))
  ) {
    return undefined;
  }
  return candidate as unknown as WorkerReport;
}

export async function readWorkerReport(
  path: string,
): Promise<{ report?: WorkerReport; warnings: string[] }> {
  try {
    const report = parseReport(JSON.parse(await readFile(path, "utf8")) as unknown);
    return report
      ? { report, warnings: [] }
      : { warnings: ["Worker report did not match the version 0 schema."] };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    return {
      warnings: [
        code === "ENOENT"
          ? "Worker did not produce a report; Git and process evidence were retained."
          : "Worker report could not be parsed; Git and process evidence were retained.",
      ],
    };
  }
}

export function reportInstructions(path: string): string {
  return `Before exiting, write a JSON report to ${JSON.stringify(path)} with this exact shape: {"version":0,"status":"completed|partial|blocked|failed","summary":"...","claimedTests":[],"concerns":[],"followUps":[],"artifacts":[]}. Artifact paths must be workspace-relative files; list ignored build outputs such as release ZIPs so the manager retains them before worktree cleanup. Do not add the report file to Git and do not commit changes; the manager owns Git commits. Report "completed" when the requested implementation and checks are complete—the absence of your own commit is expected and must not downgrade the outcome. Use "partial" only when requested work remains incomplete. If no change is needed, add "noChangeReason":"...".`;
}
