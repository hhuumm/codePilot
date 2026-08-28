import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ValidationResult } from "./domain.js";
import { isolatedAgentEnvironment } from "./providers/process.js";

const MAX_VALIDATION_OUTPUT_BYTES = 1024 * 1024;

function appendBounded(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current) >= MAX_VALIDATION_OUTPUT_BYTES) return current;
  const available = MAX_VALIDATION_OUTPUT_BYTES - Buffer.byteLength(current);
  return current + chunk.subarray(0, available).toString("utf8");
}

export async function discoverValidationCommands(workspace: string): Promise<string[]> {
  try {
    const pkg = JSON.parse(await readFile(join(workspace, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    if (pkg.scripts?.check) return ["npm run check"];
    return ["test", "build", "lint"]
      .filter((name) => pkg.scripts?.[name])
      .map((name) => `npm run ${name}`);
  } catch {
    return [];
  }
}

export async function runValidation(command: string, workspace: string, timeoutMs = 10 * 60_000): Promise<ValidationResult> {
  const started = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(command, {
      cwd: workspace,
      shell: true,
      env: isolatedAgentEnvironment(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout = appendBounded(stdout, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = appendBounded(stderr, chunk)));
    child.once("error", (error) => {
      stderr += error.message;
      resolve({ command, exitCode: 1, durationMs: Date.now() - started, stdout, stderr });
    });
    child.once("close", (code) =>
      resolve({ command, exitCode: code ?? 1, durationMs: Date.now() - started, stdout, stderr }),
    );
  });
}
