import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { isolatedAgentEnvironment } from "../../src/providers/process";
import { pmModel } from "../../src/model-config";

type Message = { id?: number; method?: string; result?: unknown; error?: { message?: string }; params?: Record<string, unknown> };
type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export class CodexAppServer {
  #process?: ChildProcessWithoutNullStreams;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #turns = new Map<string, Pending>();
  #completed = new Map<string, unknown>();
  #messages = new Map<string, string>();
  #ready?: Promise<void>;

  async startThread(repo: string, instructions: string): Promise<string> {
    await this.#ensureReady();
    const result = await this.#request("thread/start", {
      cwd: repo,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: instructions,
      ephemeral: false,
    }) as { thread: { id: string } };
    return result.thread.id;
  }

  async resumeThread(threadId: string, repo: string, instructions: string): Promise<void> {
    await this.#ensureReady();
    await this.#request("thread/resume", {
      threadId,
      cwd: repo,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: instructions,
    });
  }

  async turn(threadId: string, repo: string, prompt: string, outputSchema: unknown): Promise<string> {
    await this.#ensureReady();
    const result = await this.#request("turn/start", {
      threadId,
      cwd: repo,
      approvalPolicy: "never",
      input: [{ type: "text", text: prompt, text_elements: [] }],
      outputSchema,
      ...optionalModel(),
    }) as { turn: { id: string } };
    const turnId = result.turn.id;
    const early = this.#completed.get(turnId);
    if (early) {
      this.#completed.delete(turnId);
      return finalMessage(early);
    }
    const completed = await new Promise<unknown>((resolve, reject) => {
      this.#turns.set(turnId, { resolve, reject });
    });
    return finalMessage(completed);
  }

  stop(): void {
    this.#process?.kill();
    this.#process = undefined;
    this.#ready = undefined;
  }

  async #ensureReady(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#ready = this.#launch();
    try { await this.#ready; } catch (error) { this.#ready = undefined; throw error; }
  }

  async #launch(): Promise<void> {
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: isolatedAgentEnvironment(),
    });
    this.#process = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
      try { this.#receive(JSON.parse(line) as Message); } catch { /* Ignore non-protocol output. */ }
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.once("exit", () => {
      const error = new Error(stderr || "Codex app-server stopped unexpectedly");
      for (const pending of this.#pending.values()) pending.reject(error);
      for (const turn of this.#turns.values()) turn.reject(error);
      this.#pending.clear(); this.#turns.clear(); this.#process = undefined; this.#ready = undefined;
    });
    await this.#request("initialize", { clientInfo: { name: "codepilot", title: "codePilot", version: "0.1.0" } }, true);
    this.#send({ method: "initialized", params: {} });
  }

  #request(method: string, params: unknown, launching = false): Promise<unknown> {
    if (!launching && !this.#process) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send({ method, id, params });
    });
  }

  #send(message: unknown): void {
    this.#process?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(message: Message): void {
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message || "Codex app-server request failed")) : pending.resolve(message.result);
      return;
    }
    if (message.method === "turn/completed") {
      const turn = message.params?.turn as { id?: string } | undefined;
      if (!turn?.id) return;
      const completed = { turn, text: this.#messages.get(turn.id) };
      this.#messages.delete(turn.id);
      const pending = this.#turns.get(turn.id);
      if (pending) { this.#turns.delete(turn.id); pending.resolve(completed); }
      else this.#completed.set(turn.id, completed);
    } else if (message.method === "item/completed") {
      const turnId = String(message.params?.turnId ?? "");
      const item = message.params?.item as { type?: string; text?: string } | undefined;
      if (turnId && item?.type === "agentMessage" && item.text) this.#messages.set(turnId, item.text);
    }
  }
}

function optionalModel(): { model: string } | Record<string, never> {
  const model = pmModel();
  return model ? { model } : {};
}

function finalMessage(value: unknown): string {
  const wrapped = value as { turn?: unknown; text?: string };
  const turn = (wrapped.turn ?? value) as { status?: string; error?: { message?: string }; items?: Array<{ type?: string; text?: string }> };
  if (turn.status === "failed") throw new Error(turn.error?.message || "PM turn failed");
  const text = wrapped.text ?? [...(turn.items ?? [])].reverse().find((item) => item.type === "agentMessage")?.text;
  if (!text) throw new Error("PM turn completed without an assistant response");
  return text;
}
