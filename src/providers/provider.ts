import type { AgentEvent, AgentResult, AgentTask, ProviderName } from "../domain.js";

export interface ProviderAdapter {
  readonly name: ProviderName;
  checkAvailability(): Promise<void>;
  run(task: AgentTask, onEvent: (event: AgentEvent) => void, signal?: AbortSignal): Promise<AgentResult>;
}
