export const providerNames = ["codex", "claude"] as const;
export type ProviderName = (typeof providerNames)[number];

export type TaskStatus =
  | "queued"
  | "leased"
  | "running"
  | "validating"
  | "completed"
  | "failed";

export type RunStatus = "running" | "completed" | "needs_review" | "failed";

export interface AgentTask {
  id: string;
  externalId?: string;
  runId: string;
  objective: string;
  provider: ProviderName;
  baseCommit: string;
  workspace: string;
  reportPath: string;
  coordinationRepo?: string;
  checkoutLeaseMs?: number;
  checkoutPriority?: number;
  checkoutCommand?: string;
  dependencies: string[];
  attempts: number;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export type WorkerOutcome = "completed" | "partial" | "blocked" | "failed";

export interface WorkerReport {
  version: 0;
  status: WorkerOutcome;
  summary: string;
  claimedTests: string[];
  concerns: string[];
  followUps: string[];
  noChangeReason?: string;
  artifacts?: string[];
}

export interface WorkerVerification {
  processExitCode: number;
  baseCommit: string;
  headCommit: string;
  resultCommit?: string;
  changedPaths: string[];
  dirtyPaths: string[];
  commitDescendsFromBase: boolean;
}

export interface WorkerResult {
  version: 0;
  taskId: string;
  externalId?: string;
  report?: WorkerReport;
  verification: WorkerVerification;
  warnings: string[];
  retainedArtifacts?: string[];
}

export interface AgentEvent {
  taskId: string;
  provider: ProviderName;
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  payload: unknown;
}

export interface AgentResult {
  taskId: string;
  exitCode: number;
  events: AgentEvent[];
}

export interface RunRequest {
  objective: string;
  repo: string;
  providers: ProviderName[];
  workItems?: Array<{ id: string; objective: string; provider: ProviderName }>;
  dryRun: boolean;
  retries?: number;
  timeoutMs?: number;
  validationCommands?: string[];
  integrate?: boolean;
}

export interface PathCollision {
  path: string;
  taskIds: string[];
}

export interface ValidationResult {
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface RunReview {
  verdict: "ready" | "needs_review" | "rejected";
  findings: string[];
}

export interface RunSummary {
  version: 0;
  runId: string;
  status: RunStatus;
  baseCommit: string;
  integrationBranch?: string;
  deliveryArtifact?: string;
  taskResults: WorkerResult[];
  collisions: PathCollision[];
  validations: ValidationResult[];
  review: RunReview;
}

export interface RepositoryContext {
  baseCommit: string;
  trackedPaths: string[];
  recentCommits: string[];
  curatedKnowledge: Array<{ title: string; content: string; tags: string[] }>;
}

export interface WorkerRequest {
  version: 0;
  task: AgentTask;
  context: RepositoryContext;
}

export interface WorkerResponse {
  version: 0;
  result: WorkerResult;
}
