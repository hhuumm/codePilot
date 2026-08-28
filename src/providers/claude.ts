import type { AgentEvent, AgentResult, AgentTask } from "../domain.js";
import type { ProviderAdapter } from "./provider.js";
import { assertCommand, runJsonLinesProcess } from "./process.js";
import { checkoutInstructions, reportInstructions } from "../result.js";
import { workerModel } from "../model-config.js";

export class ClaudeAdapter implements ProviderAdapter {
  readonly name = "claude" as const;

  async checkAvailability(): Promise<void> {
    await assertCommand("claude");
  }

  async run(task: AgentTask, onEvent: (event: AgentEvent) => void, signal?: AbortSignal): Promise<AgentResult> {
    return await runJsonLinesProcess(
      "claude",
      [
        ...(workerModel("claude") ? ["--model", workerModel("claude")!] : []),
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        `${task.objective}\n\n${checkoutInstructions(task)}\n\n${reportInstructions(task.reportPath)}`,
      ],
      task,
      onEvent,
      signal,
    );
  }
}
