import { spawn } from "node:child_process";
import type { AgentEvent, AgentResult, AgentTask } from "../domain.js";

const conversationEnvironment = /^(CODEX|CLAUDE)_(THREAD|TURN|TASK|SESSION|CONVERSATION|PARENT)(_|$)/i;
const sensitiveEnvironment = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)/i;
const allowedCredentials = new Set(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
const MAX_PROCESS_EVENTS = 5_000;
const MAX_LINE_BYTES = 256 * 1024;

export function isolatedAgentEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        !conversationEnvironment.test(name) &&
        (!sensitiveEnvironment.test(name) || allowedCredentials.has(name)),
    ),
  );
}

export async function runJsonLinesProcess(
  command: string,
  args: string[],
  task: AgentTask,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<AgentResult> {
  const events: AgentEvent[] = [];
  let eventLimitReported = false;
  const emit = (stream: AgentEvent["stream"], payload: unknown): void => {
    if (events.length >= MAX_PROCESS_EVENTS - 1) {
      if (!eventLimitReported) {
        eventLimitReported = true;
        const event: AgentEvent = {
          taskId: task.id,
          provider: task.provider,
          timestamp: new Date().toISOString(),
          stream: "system",
          payload: {
            type: "output_truncated",
            text: `Worker output exceeded ${MAX_PROCESS_EVENTS - 1} events.`,
          },
        };
        events.push(event);
        onEvent(event);
      }
      return;
    }
    const event: AgentEvent = {
      taskId: task.id,
      provider: task.provider,
      timestamp: new Date().toISOString(),
      stream,
      payload,
    };
    events.push(event);
    onEvent(event);
  };

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: task.workspace,
      env: isolatedAgentEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });

    const states = {
      stdout: { buffer: "", droppedBytes: 0 },
      stderr: { buffer: "", droppedBytes: 0 },
    };
    const emitLine = (stream: "stdout" | "stderr", rawLine: string, priorDroppedBytes: number): void => {
      let line = rawLine;
      let droppedBytes = priorDroppedBytes;
      const lineBytes = Buffer.byteLength(line);
      if (lineBytes > MAX_LINE_BYTES) {
        const retained = Buffer.from(line).subarray(0, MAX_LINE_BYTES);
        droppedBytes += lineBytes - retained.byteLength;
        line = retained.toString("utf8");
      }
      if (!line && droppedBytes === 0) return;
      const payload = droppedBytes > 0
        ? `${line}\n[codePilot truncated ${droppedBytes} byte(s) from this output line]`
        : line;
      try {
        emit(stream, JSON.parse(payload) as unknown);
      } catch {
        emit(stream, payload);
      }
    };
    const consume = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      const state = states[stream];
      state.buffer += chunk.toString("utf8");
      let newline = state.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = state.buffer.slice(0, newline).replace(/\r$/, "");
        state.buffer = state.buffer.slice(newline + 1);
        emitLine(stream, line, state.droppedBytes);
        state.droppedBytes = 0;
        newline = state.buffer.indexOf("\n");
      }
      const bytes = Buffer.byteLength(state.buffer);
      if (bytes > MAX_LINE_BYTES) {
        const retained = Buffer.from(state.buffer).subarray(0, MAX_LINE_BYTES);
        state.droppedBytes += bytes - retained.byteLength;
        state.buffer = retained.toString("utf8");
      }
    };
    const flush = (stream: "stdout" | "stderr"): void => {
      const state = states[stream];
      emitLine(stream, state.buffer.replace(/\r$/, ""), state.droppedBytes);
      state.buffer = "";
      state.droppedBytes = 0;
    };

    child.stdout.on("data", (chunk: Buffer) => consume("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => consume("stderr", chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      flush("stdout");
      flush("stderr");
      resolve({ taskId: task.id, exitCode: code ?? 1, events });
    });
  });
}

export async function assertCommand(command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, ["--version"], {
      shell: false,
      stdio: "ignore",
      env: isolatedAgentEnvironment(),
    });
    child.once("error", () => reject(new Error(`${command} is not installed or not on PATH`)));
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} availability check exited with ${code}`)),
    );
  });
}
