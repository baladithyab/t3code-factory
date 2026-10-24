import {
  EnvironmentAuthorizationError,
  FactoryIssueError,
  type FactoryIssue,
  type FactoryIssueListResult,
  type FactoryIssueTask,
  type FactoryRepository,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export type FactoryIssueFilter = "open" | "closed" | "all";

export const FACTORY_ISSUE_FILTERS: ReadonlyArray<{
  readonly value: FactoryIssueFilter;
  readonly label: string;
}> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

/** Factory tasks begin supervised; the thread's normal controls can change this later. */
export const FACTORY_DEFAULT_RUNTIME_MODE: RuntimeMode = "approval-required";

export const FACTORY_SUPERVISION_NOTICE =
  "Tasks run in an isolated worktree using the selected runtime. Starting a task does not authorize publishing, merging, or releasing.";

export interface FactoryIssuePages {
  readonly repository: FactoryRepository | null;
  readonly issues: ReadonlyArray<FactoryIssue>;
  readonly nextPage: number | null;
  readonly fetchedAt: string | null;
}

export const EMPTY_FACTORY_ISSUE_PAGES: FactoryIssuePages = {
  repository: null,
  issues: [],
  nextPage: null,
  fetchedAt: null,
};

/**
 * The first page replaces everything; later pages append. An issue that moved between pages
 * while the user was scrolling keeps its earliest position and takes the newest data.
 */
export function applyFactoryIssuePage(
  current: FactoryIssuePages,
  page: number,
  result: FactoryIssueListResult,
): FactoryIssuePages {
  if (page <= 1 || current.repository?.canonicalKey !== result.repository.canonicalKey) {
    return {
      repository: result.repository,
      issues: result.issues,
      nextPage: result.nextPage,
      fetchedAt: result.fetchedAt,
    };
  }
  const incoming = new Map(result.issues.map((issue) => [issue.number, issue]));
  const seen = new Set<number>();
  const merged = current.issues.map((issue) => {
    seen.add(issue.number);
    return incoming.get(issue.number) ?? issue;
  });
  for (const issue of result.issues) {
    if (!seen.has(issue.number)) merged.push(issue);
  }
  return {
    repository: result.repository,
    issues: merged,
    nextPage: result.nextPage,
    fetchedAt: result.fetchedAt,
  };
}

export type FactoryIssueAction =
  | { readonly kind: "open"; readonly label: string; readonly task: FactoryIssueTask }
  | { readonly kind: "start"; readonly label: string }
  | { readonly kind: "resume"; readonly label: string }
  | { readonly kind: "restart"; readonly label: string }
  | { readonly kind: "unavailable"; readonly label: string; readonly detail: string };

/**
 * One primary action per issue. A closed issue never starts new work, but a thread that still
 * exists stays openable. A deleted task needs an explicit new attempt, never an implicit one.
 */
export function factoryIssueAction(issue: FactoryIssue): FactoryIssueAction {
  const task = issue.task;
  const closedDetail = "Closed issues can't start new tasks.";
  if (task === null) {
    return issue.state === "closed"
      ? { kind: "unavailable", label: "Closed", detail: closedDetail }
      : { kind: "start", label: "Start task" };
  }
  switch (task.status) {
    case "missing":
      return issue.state === "closed"
        ? {
            kind: "unavailable",
            label: "Thread deleted",
            detail: `The linked thread was deleted. ${closedDetail}`,
          }
        : { kind: "restart", label: "Start new attempt" };
    case "launching":
      // The reservation exists but its thread may not; Start replays the same reserved launch.
      return { kind: "resume", label: "Resume launch" };
    default:
      return { kind: "open", label: "Open thread", task };
  }
}

const TASK_STATUS_LABELS: Record<FactoryIssueTask["status"], string> = {
  launching: "Launching",
  preparing: "Preparing workspace",
  running: "Running",
  idle: "Idle",
  failed: "Failed",
  archived: "Archived",
  missing: "Thread deleted",
};

export function factoryTaskStatusLabel(status: FactoryIssueTask["status"]): string {
  return TASK_STATUS_LABELS[status];
}

export function factoryTaskStatusTone(
  status: FactoryIssueTask["status"],
): "active" | "neutral" | "danger" {
  switch (status) {
    case "launching":
    case "preparing":
    case "running":
      return "active";
    case "failed":
    case "missing":
      return "danger";
    default:
      return "neutral";
  }
}

const MAX_BODY_CHARACTERS = 4_000;
// Control characters other than tab and newline, plus bidirectional overrides and isolates that
// can reorder surrounding text.
const UNSAFE_TEXT = /(?![\t\n])[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Issue text is untrusted. It is only ever drawn as plain text, never parsed as markup or a
 * link target. This also removes characters that can disguise it and bounds its size.
 */
export function safeFactoryIssueText(value: string, limit = MAX_BODY_CHARACTERS): string {
  const cleaned = value
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_TEXT, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit).trimEnd()}…` : cleaned;
}

export function safeFactoryIssueBody(body: string | null): string | null {
  if (body === null) return null;
  const text = safeFactoryIssueText(body);
  return text.length === 0 ? null : text;
}

export type FactoryFailureKind = "auth" | "unsupported" | "repository" | "retry" | "error";

export interface FactoryFailure {
  readonly kind: FactoryFailureKind;
  readonly title: string;
  readonly detail: string;
}

const isFactoryIssueError = Schema.is(FactoryIssueError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

/** Maps a typed failure to text a person can act on; unknown failures keep their own message. */
export function describeFactoryFailure(error: unknown, fallbackTitle: string): FactoryFailure {
  if (isAuthorizationError(error)) {
    return {
      kind: "auth",
      title: "Not permitted",
      detail: "This connection isn't allowed to do that in this environment.",
    };
  }
  if (isFactoryIssueError(error)) {
    switch (error.reason) {
      case "unsupported-provider":
        return { kind: "unsupported", title: "Repository not supported", detail: error.message };
      case "authentication":
        return { kind: "auth", title: "GitHub sign-in required", detail: error.message };
      case "rate-limited":
        return { kind: "retry", title: "GitHub rate limit reached", detail: error.message };
      case "missing-project":
      case "missing-repository":
      case "repository-changed":
        return { kind: "repository", title: "Repository unavailable", detail: error.message };
      case "launch-failure":
        return { kind: "retry", title: "Launch interrupted", detail: error.message };
      case "deleted-task":
        return { kind: "retry", title: "Confirm a new attempt", detail: error.message };
      default:
        return { kind: "error", title: fallbackTitle, detail: error.message };
    }
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return { kind: "error", title: fallbackTitle, detail: error.message };
  }
  return { kind: "error", title: fallbackTitle, detail: "The request failed. Try again." };
}

export function factoryRepositoryLabel(repository: FactoryRepository): string {
  return repository.host === "github.com"
    ? repository.repository
    : `${repository.host}/${repository.repository}`;
}

export function factoryIssueStartKey(input: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly expectedRepositoryKey: string;
  readonly issueNumber: number;
  readonly restartDeleted: boolean;
  readonly previousThreadId: string | null;
}): string {
  return JSON.stringify([
    input.environmentId,
    input.projectId,
    input.expectedRepositoryKey,
    input.issueNumber,
    input.restartDeleted,
    input.previousThreadId,
  ]);
}

export interface FactoryInboxTargetCandidate<
  EnvironmentKey extends string,
  ProjectKey extends string,
> {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentKey;
    readonly supported: boolean;
  }>;
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentKey;
    readonly projectId: ProjectKey;
  }>;
  readonly preferred: {
    readonly environmentId: EnvironmentKey | null;
    readonly projectId: ProjectKey | null;
  };
  /** Projects the rest of settings currently points at, in priority order. */
  readonly hints: ReadonlyArray<{
    readonly environmentId: EnvironmentKey;
    readonly projectId: ProjectKey;
  }>;
}

/**
 * Picks the environment and project the inbox shows. The user's last choice wins while it still
 * exists; otherwise the project Settings is scoped to, then the first supported environment.
 */
export function resolveFactoryInboxTarget<EnvironmentKey extends string, ProjectKey extends string>(
  input: FactoryInboxTargetCandidate<EnvironmentKey, ProjectKey>,
): {
  readonly environmentId: EnvironmentKey | null;
  readonly projectId: ProjectKey | null;
} {
  const known = new Set(input.environments.map((entry) => entry.environmentId));
  const supported = input.environments.filter((entry) => entry.supported);
  const environmentId =
    (input.preferred.environmentId !== null && known.has(input.preferred.environmentId)
      ? input.preferred.environmentId
      : null) ??
    input.hints.find((hint) =>
      supported.some((entry) => entry.environmentId === hint.environmentId),
    )?.environmentId ??
    supported[0]?.environmentId ??
    input.environments[0]?.environmentId ??
    null;
  if (environmentId === null) return { environmentId: null, projectId: null };
  const inEnvironment = input.projects.filter((project) => project.environmentId === environmentId);
  const projectId =
    inEnvironment.find((project) => project.projectId === input.preferred.projectId)?.projectId ??
    input.hints.find(
      (hint) =>
        hint.environmentId === environmentId &&
        inEnvironment.some((project) => project.projectId === hint.projectId),
    )?.projectId ??
    inEnvironment[0]?.projectId ??
    null;
  return { environmentId, projectId };
}

/** The server returns the issue URL, but only an https link is worth handing to the system. */
export function safeFactoryIssueUrl(url: string): string | null {
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
