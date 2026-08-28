import type { AgentEvent, AgentResult, AgentTask } from "../domain.js";
import type { ProviderAdapter } from "./provider.js";
import { assertCommand, runJsonLinesProcess } from "./process.js";
import { reportInstructions } from "../result.js";
import { workerModel } from "../model-config.js";
import { checkoutInstructions } from "../result.js";

export class CodexAdapter implements ProviderAdapter {
  readonly name = "codex" as const;

  async checkAvailability(): Promise<void> {
    await assertCommand("codex");
  }

  async run(task: AgentTask, onEvent: (event: AgentEvent) => void, signal?: AbortSignal): Promise<AgentResult> {
    return await runJsonLinesProcess(
      "codex",
      codexArguments(task),
      task,
      onEvent,
      signal,
    );
  }
}

export function codexArguments(task: AgentTask, environment: NodeJS.ProcessEnv = process.env): string[] {
  const windowsWriteFallback = process.platform === "win32"
    ? "Windows worker rule: do not use the native apply_patch/file_change helper. Use scoped PowerShell [System.IO.File]::WriteAllText or Set-Content immediately, and only write inside the assigned workspace. Verify the resulting text before testing."
    : "";
  const model = workerModel("codex", environment);
  return ["exec", "--ephemeral", ...(model ? ["--model", model] : []), "--json", "--sandbox", "workspace-write", "--cd", task.workspace, `${task.objective}\n\n${windowsWriteFallback}\n\n${checkoutInstructions(task)}\n\n${reportInstructions(task.reportPath)}`];
}
