import {
  EnvironmentAuthorizationError,
  FACTORY_DELIVERY_TITLE_MAX_CHARS,
  FactoryAcceptanceError,
  FactoryDeliveryError,
  FactoryIssueError,
  type FactoryAcceptance,
  type FactoryAcceptanceReadResult,
  type FactoryDeliveryIntent,
  type FactoryDeliveryPayload,
  type FactoryDeliveryPrepareResult,
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
 * Row previews are plain text, never markup or link targets. They remove disguising characters
 * and bound rendering cost; approval uses the separate, complete review representation.
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

export type FactoryFailureKind =
  | "auth"
  | "unsupported"
  | "repository"
  | "changed"
  | "retry"
  | "error";

export interface FactoryFailure {
  readonly kind: FactoryFailureKind;
  readonly title: string;
  readonly detail: string;
}

const isFactoryIssueError = Schema.is(FactoryIssueError);
const isFactoryAcceptanceError = Schema.is(FactoryAcceptanceError);
const isFactoryDeliveryError = Schema.is(FactoryDeliveryError);
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
      case "issue-changed":
        return { kind: "changed", title: "Issue changed", detail: error.message };
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

export function shortFactorySha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * What the accepted-commit section can honestly say. An unreadable worktree is never shown as
 * "head moved": the server reports `current: false` then, but nothing is known to have moved.
 */
export type FactoryAcceptanceView =
  | { readonly kind: "none"; readonly liveHeadSha: string | null }
  | { readonly kind: "current"; readonly acceptance: FactoryAcceptance }
  | {
      readonly kind: "moved";
      readonly acceptance: FactoryAcceptance;
      readonly liveHeadSha: string;
    }
  | { readonly kind: "unverifiable"; readonly acceptance: FactoryAcceptance };

export function factoryAcceptanceView(read: FactoryAcceptanceReadResult): FactoryAcceptanceView {
  const { acceptance, liveHeadSha } = read;
  if (acceptance === null) return { kind: "none", liveHeadSha };
  if (read.current) return { kind: "current", acceptance };
  if (liveHeadSha === null) return { kind: "unverifiable", acceptance };
  return { kind: "moved", acceptance, liveHeadSha };
}

export function describeFactoryAcceptanceFailure(error: unknown): FactoryFailure {
  if (isFactoryAcceptanceError(error)) {
    switch (error.reason) {
      case "head-moved":
        return {
          kind: "changed",
          title: "Head moved",
          detail: "The head moved while you were reviewing. Refresh and review again.",
        };
      case "already-accepted":
        return {
          kind: "changed",
          title: "Already accepted",
          detail:
            "A commit is already accepted for this task. Refresh, then use Re-accept at current head to replace it.",
        };
      case "worktree-unavailable":
        return { kind: "repository", title: "Worktree unavailable", detail: error.message };
      default:
        return { kind: "error", title: "Couldn't accept the commit", detail: error.message };
    }
  }
  return describeFactoryFailure(error, "Couldn't accept the commit");
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
  readonly expectedIssueRevision: string;
  readonly restartDeleted: boolean;
  readonly previousThreadId: string | null;
}): string {
  return JSON.stringify([
    input.environmentId,
    input.projectId,
    input.expectedRepositoryKey,
    input.issueNumber,
    input.expectedIssueRevision,
    input.restartDeleted,
    input.previousThreadId,
  ]);
}

/** The server returns the issue URL, but only an https link is worth handing to the system. */
export function safeFactoryIssueUrl(url: string): string | null {
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

const FACTORY_DELIVERY_TITLE_LIMIT = FACTORY_DELIVERY_TITLE_MAX_CHARS;

export const FACTORY_DELIVERY_HEAD_MOVED =
  "The head moved since acceptance. Re-accept, then prepare again.";
export const FACTORY_DELIVERY_PAYLOAD_CHANGED =
  "The title or body changed since the preview. Prepare again.";
export const FACTORY_DELIVERY_ALREADY_DELIVERING =
  "A pull request is already being published for this task.";

/** The editable starting point: nothing is published until a human grants this exact preview. */
export function factoryDeliveryDefaultPayload(issue: {
  readonly number: number;
  readonly title: string;
  readonly url: string;
}): FactoryDeliveryPayload {
  const title =
    safeFactoryIssueText(issue.title, FACTORY_DELIVERY_TITLE_LIMIT - 1) || `Issue #${issue.number}`;
  const url = safeFactoryIssueUrl(issue.url);
  return { title, body: url === null ? `Issue #${issue.number}` : `Issue: ${url}`, draft: true };
}

/** The server trims the title when decoding, so a trailing space is not an edit. */
export function sameFactoryDeliveryPayload(
  previewed: FactoryDeliveryPayload,
  draft: FactoryDeliveryPayload,
): boolean {
  return (
    previewed.title === draft.title.trim() &&
    previewed.body === draft.body &&
    previewed.draft === draft.draft
  );
}

// Confirmed is live too: one pull request per task, and re-publishing is out of scope.
export function isLiveFactoryDelivery(intent: FactoryDeliveryIntent): boolean {
  return intent.status !== "failed";
}

/**
 * Why Grant publish is unavailable, or null when it may be pressed. The grant echoes the last
 * preview, so anything that would make the server refuse it is stated here before the tap.
 */
export function factoryDeliveryGrantBlocker(input: {
  readonly permitted: boolean;
  readonly acceptedHeadSha: string | null;
  readonly acceptanceCurrent: boolean;
  readonly liveIntent: FactoryDeliveryIntent | null;
  readonly prepared: FactoryDeliveryPrepareResult | null;
  readonly draft: FactoryDeliveryPayload;
}): string | null {
  if (!input.permitted) {
    return "This connection isn't permitted to publish pull requests in this environment.";
  }
  if (input.liveIntent !== null) {
    return input.liveIntent.status === "confirmed"
      ? "A pull request was already published for this task."
      : FACTORY_DELIVERY_ALREADY_DELIVERING;
  }
  if (!input.acceptanceCurrent) return "Publishing needs a current accepted commit.";
  const { prepared } = input;
  if (prepared === null) return "Prepare a preview before granting.";
  if (!prepared.current || prepared.headSha !== input.acceptedHeadSha) {
    return FACTORY_DELIVERY_HEAD_MOVED;
  }
  if (prepared.existing !== null && isLiveFactoryDelivery(prepared.existing)) {
    return FACTORY_DELIVERY_ALREADY_DELIVERING;
  }
  if (!sameFactoryDeliveryPayload(prepared.payload, input.draft)) {
    return FACTORY_DELIVERY_PAYLOAD_CHANGED;
  }
  return null;
}

export type FactoryDeliveryStatusView =
  | { readonly kind: "publishing"; readonly text: string }
  | { readonly kind: "confirmed"; readonly text: string; readonly url: string | null }
  | { readonly kind: "failed"; readonly text: string }
  | { readonly kind: "unknown"; readonly text: string };

export function factoryDeliveryStatusView(
  intent: FactoryDeliveryIntent,
): FactoryDeliveryStatusView {
  switch (intent.status) {
    case "pending":
    case "sending":
      return { kind: "publishing", text: "Publishing…" };
    case "confirmed":
      return intent.remote === null
        ? { kind: "confirmed", text: "Pull request published", url: null }
        : {
            kind: "confirmed",
            text: `Pull request #${intent.remote.number}`,
            url: safeFactoryIssueUrl(intent.remote.url),
          };
    case "failed":
      return { kind: "failed", text: intent.failure ?? "Publishing failed." };
    case "unknown":
      return {
        kind: "unknown",
        text: "The server lost the response. Reconcile to check GitHub.",
      };
  }
}

export function describeFactoryDeliveryFailure(error: unknown): FactoryFailure {
  if (isFactoryDeliveryError(error)) {
    switch (error.reason) {
      case "head-moved":
      case "acceptance-stale":
        return { kind: "changed", title: "Head moved", detail: FACTORY_DELIVERY_HEAD_MOVED };
      case "payload-changed":
        return {
          kind: "changed",
          title: "Preview changed",
          detail: FACTORY_DELIVERY_PAYLOAD_CHANGED,
        };
      case "already-delivering":
        return {
          kind: "changed",
          title: "Already publishing",
          detail: FACTORY_DELIVERY_ALREADY_DELIVERING,
        };
      case "not-accepted":
        return {
          kind: "changed",
          title: "No accepted commit",
          detail: "Accept a commit before publishing a pull request.",
        };
      case "worktree-unavailable":
        return { kind: "repository", title: "Worktree unavailable", detail: error.message };
      default:
        return { kind: "error", title: "Couldn't publish", detail: error.message };
    }
  }
  return describeFactoryFailure(error, "Couldn't publish");
}
