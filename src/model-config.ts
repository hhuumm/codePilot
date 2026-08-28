/** Default OpenAI model split: balanced PM, cost-sensitive coding workers. */
export const DEFAULT_PM_MODEL = "gpt-5.6-terra";
export const DEFAULT_CODEX_WORKER_MODEL = "gpt-5.6-luna";

export type ModelEnvironment = NodeJS.ProcessEnv;

export function pmModel(environment: ModelEnvironment = process.env): string | undefined {
  return nonEmpty(environment.CODEPILOT_PM_MODEL) ?? DEFAULT_PM_MODEL;
}

export function workerModel(provider: "codex" | "claude", environment: ModelEnvironment = process.env): string | undefined {
  return nonEmpty(provider === "codex" ? environment.CODEPILOT_WORKER_MODEL : environment.CODEPILOT_CLAUDE_WORKER_MODEL)
    ?? (provider === "codex" ? DEFAULT_CODEX_WORKER_MODEL : undefined);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
