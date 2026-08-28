import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunSummary } from "./domain.js";

export async function writePullRequestDraft(
  stateDirectory: string,
  objective: string,
  summary: RunSummary,
): Promise<string> {
  const path = join(stateDirectory, "runs", summary.runId, "pull-request.md");
  await mkdir(dirname(path), { recursive: true });
  const commits = summary.taskResults
    .flatMap((result) => (result.verification.resultCommit ? [`- ${result.verification.resultCommit}`] : []))
    .join("\n");
  const validations = summary.validations
    .map((result) => `- ${result.exitCode === 0 ? "PASS" : "FAIL"}: \`${result.command}\``)
    .join("\n");
  await writeFile(
    path,
    `# ${objective}\n\nIntegration branch: \`${summary.integrationBranch ?? "none"}\`\n\n## Worker commits\n\n${commits || "- None"}\n\n## Validation\n\n${validations || "- Not run"}\n\n## Review\n\nVerdict: **${summary.review.verdict}**\n\n${summary.review.findings.map((finding) => `- ${finding}`).join("\n") || "- No findings"}\n`,
  );
  return path;
}
