const guidance = new Map<string, string[]>();
const interrupts = new Map<string, () => void>();

export function queueAgentGuidance(taskId: string, message: string): void {
  const trimmed = message.trim();
  if (!trimmed) throw new Error("Guidance cannot be empty.");
  guidance.set(taskId, [...(guidance.get(taskId) ?? []), trimmed]);
}

export function drainAgentGuidance(taskId: string): string[] {
  const messages = guidance.get(taskId) ?? [];
  guidance.delete(taskId);
  return messages;
}

export function pendingAgentGuidance(taskId: string): number {
  return guidance.get(taskId)?.length ?? 0;
}

export function clearAgentGuidance(taskId: string): void {
  guidance.delete(taskId);
}

export function registerAgentInterrupt(taskId: string, abort: () => void): void {
  interrupts.set(taskId, abort);
}

export function clearAgentInterrupt(taskId: string): void {
  interrupts.delete(taskId);
}

export function interruptAgent(taskId: string): boolean {
  const abort = interrupts.get(taskId);
  if (!abort) return false;
  abort();
  return true;
}
