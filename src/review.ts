import type { PathCollision, RunReview, ValidationResult, WorkerResult } from "./domain.js";

export function reviewRun(
  results: WorkerResult[],
  collisions: PathCollision[],
  validations: ValidationResult[],
): RunReview {
  const findings: string[] = [];
  if (results.length === 0) findings.push("No worker results were produced.");
  if (collisions.length > 0) findings.push(`${collisions.length} changed-path collision(s) require review.`);
  for (const result of results) findings.push(...result.warnings.map((warning) => `${result.taskId}: ${warning}`));
  if (results.some((result) => !result.verification.resultCommit && !result.report?.noChangeReason)) {
    findings.push("At least one worker produced neither a commit nor a no-change reason.");
  }
  if (validations.some((validation) => validation.exitCode !== 0)) findings.push("Validation failed.");
  const rejected = validations.some((validation) => validation.exitCode !== 0);
  return { verdict: rejected ? "rejected" : findings.length > 0 ? "needs_review" : "ready", findings };
}
