import {
  EnvironmentAuthorizationError,
  FACTORY_DELIVERY_TITLE_MAX_CHARS,
  FactoryAcceptanceError,
  FactoryDeliveryError,
  FactoryIssueError,
  type FactoryAcceptance,
  type FactoryAcceptanceReadResult,
  type FactoryArtifactDeliveryIntent,
  type FactoryArtifactDeliveryPrepareResult,
  type FactoryCommitDeliveryIntent,
  type FactoryCommitDeliveryPrepareResult,
  type FactoryDeliveryCommitPayload,
  type FactoryDeliveryDestinationIssue,
  type FactoryDeliveryIntent,
  type FactoryDeliveryMergePayload,
  type FactoryDeliveryPrepareResult,
  type FactoryDeliveryPublishPayload,
  type FactoryIssue,
  type FactoryIssueCapabilities,
  type FactoryIssueListResult,
  type FactoryIssueTask,
  type FactoryRepository,
  type PullRequestMergeability,
  type PullRequestMergeMethod,
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
  /** What the issue host supports; null until the first page lands. */
  readonly capabilities: FactoryIssueCapabilities | null;
  readonly issues: ReadonlyArray<FactoryIssue>;
  readonly nextPage: number | null;
  readonly fetchedAt: string | null;
}

export const EMPTY_FACTORY_ISSUE_PAGES: FactoryIssuePages = {
  repository: null,
  capabilities: null,
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
      capabilities: result.capabilities,
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
    capabilities: result.capabilities,
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

/**
 * Maps a typed failure to text a person can act on; unknown failures keep their own message.
 * `displayName` names the issue host when it is known; a list that never loaded has none, so the
 * title stays provider-neutral rather than guessing a host.
 */
export function describeFactoryFailure(
  error: unknown,
  fallbackTitle: string,
  displayName?: string,
): FactoryFailure {
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
        return {
          kind: "auth",
          title: displayName ? `${displayName} sign-in required` : "Sign-in required",
          detail: error.message,
        };
      case "rate-limited":
        return {
          kind: "retry",
          title: displayName ? `${displayName} rate limit reached` : "Rate limit reached",
          detail: error.message,
        };
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
}): FactoryDeliveryPublishPayload {
  const title =
    safeFactoryIssueText(issue.title, FACTORY_DELIVERY_TITLE_LIMIT - 1) || `Issue #${issue.number}`;
  const url = safeFactoryIssueUrl(issue.url);
  return { title, body: url === null ? `Issue #${issue.number}` : `Issue: ${url}`, draft: true };
}

/** The server trims the title when decoding, so a trailing space is not an edit. */
export function sameFactoryDeliveryPayload(
  previewed: FactoryDeliveryPublishPayload,
  draft: FactoryDeliveryPublishPayload,
): boolean {
  return (
    previewed.title === draft.title.trim() &&
    previewed.body === draft.body &&
    previewed.draft === draft.draft
  );
}

// Confirmed is live too: one pull request and one merge per task, and redoing either is out of
// scope.
export function isLiveFactoryDelivery(intent: FactoryDeliveryIntent): boolean {
  return intent.status !== "failed";
}

// Stored publish payloads have no merge method, which is what tells the two shapes apart.
export function isFactoryMergePayload(
  payload: FactoryDeliveryCommitPayload,
): payload is FactoryDeliveryMergePayload {
  return "mergeMethod" in payload;
}

// A prepare answers one of two shapes; only an artifact preview carries the artifact digest.
export function isFactoryArtifactPrepareResult(
  result: FactoryDeliveryPrepareResult,
): result is FactoryArtifactDeliveryPrepareResult {
  return "artifactSha256" in result;
}

export function isFactoryArtifactIntent(
  intent: FactoryDeliveryIntent,
): intent is FactoryArtifactDeliveryIntent {
  return intent.kind === "publish-artifact";
}

// A commit-backed row: the pull request and merge sections never show a comment row.
export function isFactoryCommitIntent(
  intent: FactoryDeliveryIntent,
): intent is FactoryCommitDeliveryIntent {
  return intent.kind !== "publish-artifact";
}

/**
 * Why Grant publish is unavailable, or null when it may be pressed. The grant echoes the last
 * preview, so anything that would make the server refuse it is stated here before the tap.
 */
export function factoryDeliveryGrantBlocker(input: {
  readonly permitted: boolean;
  readonly acceptedHeadSha: string | null;
  readonly acceptanceCurrent: boolean;
  readonly liveIntent: FactoryCommitDeliveryIntent | null;
  readonly prepared: FactoryCommitDeliveryPrepareResult | null;
  readonly draft: FactoryDeliveryPublishPayload;
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
  if (
    isFactoryMergePayload(prepared.payload) ||
    !sameFactoryDeliveryPayload(prepared.payload, input.draft)
  ) {
    return FACTORY_DELIVERY_PAYLOAD_CHANGED;
  }
  return null;
}

export const FACTORY_MERGE_METHODS: ReadonlyArray<{
  readonly value: PullRequestMergeMethod;
  readonly label: string;
  readonly accessibilityLabel: string;
}> = [
  { value: "merge", label: "Merge", accessibilityLabel: "Create a merge commit" },
  { value: "squash", label: "Squash", accessibilityLabel: "Squash and merge" },
  { value: "rebase", label: "Rebase", accessibilityLabel: "Rebase and merge" },
];

export const FACTORY_DEFAULT_MERGE_METHOD: PullRequestMergeMethod = "squash";

export const FACTORY_MERGE_NOT_PUBLISHED = "Publish the pull request first.";
export const FACTORY_MERGE_PR_HEAD_MOVED =
  "The pull request head is not the accepted commit. Re-accept and refresh.";
export const FACTORY_MERGE_ALREADY_MERGED = "This pull request is already merged.";
export const factoryMergeNotMergeable = (displayName: string) =>
  `${displayName} reports the pull request cannot be merged right now.`;
export const FACTORY_MERGE_ALREADY_MERGING = "A merge is already in progress for this task.";
export const FACTORY_MERGE_METHOD_CHANGED =
  "The merge method changed since the preview. Prepare again.";
export const factoryMergeDraft = (displayName: string) =>
  `The pull request is a draft. Mark it ready for review on ${displayName}, then prepare again.`;

type FactoryMergePullRequest = NonNullable<FactoryCommitDeliveryPrepareResult["pullRequest"]>;

export function factoryMergeabilityLabel(
  mergeability: PullRequestMergeability,
  displayName: string,
): string {
  switch (mergeability) {
    case "mergeable":
      return "No merge conflicts";
    case "conflicting":
      return "Has merge conflicts";
    case "unknown":
      return `${displayName} has not decided mergeability yet`;
  }
}

/**
 * Compares the pull request's head with the accepted commit. An unreadable head never matches:
 * the server refuses to merge anything it cannot pin to the accepted commit.
 */
export function factoryPullRequestHeadView(
  pullRequest: FactoryMergePullRequest,
  acceptedHeadSha: string | null,
): { readonly matches: boolean; readonly text: string } {
  if (pullRequest.headSha === null) {
    return { matches: false, text: "The pull request head could not be read." };
  }
  const head = shortFactorySha(pullRequest.headSha);
  if (acceptedHeadSha === null) {
    return { matches: false, text: `Head ${head}. No accepted commit to compare.` };
  }
  return pullRequest.headSha === acceptedHeadSha
    ? { matches: true, text: `Head ${head} matches the accepted commit.` }
    : {
        matches: false,
        text: `Head ${head} is not the accepted commit ${shortFactorySha(acceptedHeadSha)}.`,
      };
}

/**
 * Why Grant merge is unavailable, or null when it may be pressed. The host's branch protection
 * still decides required checks and reviews; this only states what would make the server or
 * the host refuse this exact grant.
 */
export function factoryMergeGrantBlocker(input: {
  readonly permitted: boolean;
  readonly acceptedHeadSha: string | null;
  readonly acceptanceCurrent: boolean;
  readonly liveIntent: FactoryCommitDeliveryIntent | null;
  readonly prepared: FactoryCommitDeliveryPrepareResult | null;
  readonly mergeMethod: PullRequestMergeMethod;
  readonly displayName: string;
}): string | null {
  if (!input.permitted) {
    return "This connection isn't permitted to merge pull requests in this environment.";
  }
  if (input.liveIntent !== null) {
    return input.liveIntent.status === "confirmed"
      ? FACTORY_MERGE_ALREADY_MERGED
      : FACTORY_MERGE_ALREADY_MERGING;
  }
  if (!input.acceptanceCurrent) return "Merging needs a current accepted commit.";
  const { prepared } = input;
  if (prepared === null) return "Prepare a merge preview before granting.";
  if (!prepared.current || prepared.headSha !== input.acceptedHeadSha) {
    return FACTORY_DELIVERY_HEAD_MOVED;
  }
  const pullRequest = prepared.pullRequest ?? null;
  if (pullRequest === null) return FACTORY_MERGE_NOT_PUBLISHED;
  if (pullRequest.state === "merged") return FACTORY_MERGE_ALREADY_MERGED;
  if (pullRequest.state === "closed") return "This pull request is closed.";
  if (!factoryPullRequestHeadView(pullRequest, input.acceptedHeadSha).matches) {
    return FACTORY_MERGE_PR_HEAD_MOVED;
  }
  if (pullRequest.isDraft) return factoryMergeDraft(input.displayName);
  if (pullRequest.mergeability === "conflicting") {
    return factoryMergeNotMergeable(input.displayName);
  }
  if (prepared.existing !== null && isLiveFactoryDelivery(prepared.existing)) {
    return prepared.existing.status === "confirmed"
      ? FACTORY_MERGE_ALREADY_MERGED
      : FACTORY_MERGE_ALREADY_MERGING;
  }
  if (
    !isFactoryMergePayload(prepared.payload) ||
    prepared.payload.mergeMethod !== input.mergeMethod
  ) {
    return FACTORY_MERGE_METHOD_CHANGED;
  }
  if (!pullRequest.mergeMethods.includes(input.mergeMethod)) {
    return `The repository does not allow ${input.mergeMethod} merges. Choose another method.`;
  }
  return null;
}

export type FactoryDeliveryStatusView =
  | { readonly kind: "in-progress"; readonly text: string }
  | {
      readonly kind: "confirmed";
      readonly text: string;
      readonly link: { readonly label: string; readonly url: string } | null;
    }
  | { readonly kind: "failed"; readonly text: string }
  | { readonly kind: "unknown"; readonly text: string };

/**
 * Publish, merge, and comment rows share a list shape, so each says which act it records. A
 * comment names its host by the repository it was granted for, never by a guessed display name.
 */
export function factoryDeliveryStatusView(
  intent: FactoryDeliveryIntent,
  displayName: string,
): FactoryDeliveryStatusView {
  if (isFactoryArtifactIntent(intent)) return factoryArtifactDeliveryStatusView(intent);
  const merge = intent.kind === "merge-pr";
  switch (intent.status) {
    case "pending":
    case "sending":
      return { kind: "in-progress", text: merge ? "Merging…" : "Publishing…" };
    case "confirmed": {
      if (intent.remote === null) {
        return {
          kind: "confirmed",
          text: merge ? "Merged" : "Pull request published",
          link: null,
        };
      }
      const { number } = intent.remote;
      const url = safeFactoryIssueUrl(intent.remote.url);
      return {
        kind: "confirmed",
        text: merge ? `Merged pull request #${number}` : `Published pull request #${number}`,
        link: url === null ? null : { label: `Open pull request #${number}`, url },
      };
    }
    case "failed":
      return {
        kind: "failed",
        text: intent.failure ?? (merge ? "Merging failed." : "Publishing failed."),
      };
    case "unknown":
      return {
        kind: "unknown",
        text: merge
          ? `The server lost the merge response. Reconcile to check ${displayName}.`
          : `The server lost the response. Reconcile to check ${displayName}.`,
      };
  }
}

/** What a host that cannot publish says instead of offering the pull request controls. */
export const factoryPublishUnsupportedText = (displayName: string) =>
  `Publishing from ${displayName} is not supported yet.`;

export function describeFactoryDeliveryFailure(
  error: unknown,
  displayName: string,
): FactoryFailure {
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
      case "capability-unsupported":
        return {
          kind: "unsupported",
          title: "Not supported",
          detail: factoryPublishUnsupportedText(displayName),
        };
      default:
        return { kind: "error", title: "Couldn't publish", detail: error.message };
    }
  }
  return describeFactoryFailure(error, "Couldn't publish", displayName);
}

export function describeFactoryMergeFailure(error: unknown, displayName: string): FactoryFailure {
  if (isFactoryDeliveryError(error)) {
    switch (error.reason) {
      case "not-published":
        return { kind: "changed", title: "Not published", detail: FACTORY_MERGE_NOT_PUBLISHED };
      case "pull-request-head-moved":
        return {
          kind: "changed",
          title: "Pull request head moved",
          detail: FACTORY_MERGE_PR_HEAD_MOVED,
        };
      case "already-merged":
        return { kind: "changed", title: "Already merged", detail: FACTORY_MERGE_ALREADY_MERGED };
      case "not-mergeable":
        return {
          kind: "retry",
          title: "Not mergeable",
          detail: factoryMergeNotMergeable(displayName),
        };
      case "head-moved":
      case "acceptance-stale":
        return { kind: "changed", title: "Head moved", detail: FACTORY_DELIVERY_HEAD_MOVED };
      case "payload-changed":
        return { kind: "changed", title: "Preview changed", detail: FACTORY_MERGE_METHOD_CHANGED };
      case "already-delivering":
        return {
          kind: "changed",
          title: "Already merging",
          detail: FACTORY_MERGE_ALREADY_MERGING,
        };
      case "not-accepted":
        return {
          kind: "changed",
          title: "No accepted commit",
          detail: "Accept a commit before merging a pull request.",
        };
      case "capability-unsupported":
        return {
          kind: "unsupported",
          title: "Not supported",
          detail: factoryPublishUnsupportedText(displayName),
        };
      default:
        return { kind: "error", title: "Couldn't merge", detail: error.message };
    }
  }
  return describeFactoryFailure(error, "Couldn't merge", displayName);
}

export const FACTORY_ARTIFACT_ALREADY_DELIVERING =
  "A comment with this deliverable is already being posted, or was posted, on that issue.";
export const FACTORY_ARTIFACT_CHANGED =
  "The deliverable changed since it was accepted. Re-accept it, then prepare again.";
export const FACTORY_ARTIFACT_PAYLOAD_CHANGED =
  "The issue number changed since the preview. Prepare again.";
export const FACTORY_ARTIFACT_NOT_ACCEPTED =
  "Accept the current artifact before posting it as an issue comment.";

/** A host that cannot comment on issues gets this one line instead of a preview. */
export const factoryIssueCommentUnsupportedText = (displayName: string | null) =>
  `${displayName ?? "This repository's host"} does not support issue comments yet.`;

/** The issue number a person typed, or null while it is not a positive whole number. */
export function parseFactoryIssueNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[1-9][0-9]{0,8}$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** Reconcile reads the host for an `unknown` or `failed` comment; it never posts again. */
export function isFactoryArtifactReconcilable(intent: FactoryArtifactDeliveryIntent): boolean {
  return intent.status === "unknown" || intent.status === "failed";
}

/** One live comment per destination: a comment on another issue never blocks this one. */
export function liveFactoryArtifactIntent(
  intents: ReadonlyArray<FactoryArtifactDeliveryIntent>,
  issueNumber: number | null,
): FactoryArtifactDeliveryIntent | null {
  if (issueNumber === null) return null;
  return (
    intents.find(
      (intent) => intent.payload.issueNumber === issueNumber && isLiveFactoryDelivery(intent),
    ) ?? null
  );
}

export function factoryArtifactDeliveryStatusView(
  intent: FactoryArtifactDeliveryIntent,
): FactoryDeliveryStatusView {
  const issue = intent.payload.issueNumber;
  switch (intent.status) {
    case "pending":
    case "sending":
      return { kind: "in-progress", text: `Posting comment on issue #${issue}…` };
    case "confirmed": {
      const url = intent.remote === null ? null : safeFactoryIssueUrl(intent.remote.url);
      return {
        kind: "confirmed",
        text: `Posted comment on issue #${issue}`,
        link: url === null ? null : { label: "Open comment", url },
      };
    }
    case "failed":
      return { kind: "failed", text: intent.failure ?? "Posting the comment failed." };
    case "unknown":
      return {
        kind: "unknown",
        text: `${intent.failure?.trim() || "The server lost the response."} Reconcile to check ${intent.repository.host}.`,
      };
  }
}

/** The destination as the host reports it now, so a person sees where the comment lands. */
export function factoryArtifactDestinationText(destination: FactoryDeliveryDestinationIssue) {
  const title = safeFactoryIssueText(destination.title, 240) || "Untitled issue";
  return `#${destination.number} ${title} (${destination.state})`;
}

/**
 * Why Grant publish is unavailable for an artifact, or null when it may be pressed. The grant
 * echoes the last preview's artifact digest and payload digest, so anything that would make the
 * server refuse it is stated here before the tap. `liveIntent` is the live comment for the
 * typed issue only: a comment on another issue never blocks this one.
 */
export function factoryArtifactGrantBlocker(input: {
  readonly permitted: boolean;
  readonly acceptedSha256: string | null;
  readonly issueNumber: number | null;
  readonly liveIntent: FactoryArtifactDeliveryIntent | null;
  readonly prepared: FactoryArtifactDeliveryPrepareResult | null;
}): string | null {
  if (!input.permitted) {
    return "This connection isn't permitted to publish issue comments in this environment.";
  }
  if (input.liveIntent !== null) {
    return input.liveIntent.status === "confirmed"
      ? "This deliverable was already posted on that issue."
      : FACTORY_ARTIFACT_ALREADY_DELIVERING;
  }
  const { prepared } = input;
  if (prepared === null) return "Prepare a preview before granting.";
  if (!prepared.current || prepared.artifactSha256 !== input.acceptedSha256) {
    return FACTORY_ARTIFACT_CHANGED;
  }
  if (prepared.existing !== null && isLiveFactoryDelivery(prepared.existing)) {
    return FACTORY_ARTIFACT_ALREADY_DELIVERING;
  }
  if (input.issueNumber === null || prepared.payload.issueNumber !== input.issueNumber) {
    return FACTORY_ARTIFACT_PAYLOAD_CHANGED;
  }
  return null;
}

/**
 * Maps a refused comment preview, grant, or reconcile to the next step. `displayName` is null
 * when no issue read has named the host, so the unsupported line stays host-neutral.
 */
export function describeFactoryArtifactDeliveryFailure(
  error: unknown,
  displayName: string | null,
): FactoryFailure {
  if (isFactoryDeliveryError(error)) {
    switch (error.reason) {
      case "artifact-changed":
      case "acceptance-stale":
        return { kind: "changed", title: "Deliverable changed", detail: FACTORY_ARTIFACT_CHANGED };
      case "payload-changed":
        return {
          kind: "changed",
          title: "Preview changed",
          detail: FACTORY_ARTIFACT_PAYLOAD_CHANGED,
        };
      case "already-delivering":
        return {
          kind: "changed",
          title: "Already posting",
          detail: FACTORY_ARTIFACT_ALREADY_DELIVERING,
        };
      case "not-accepted":
        return {
          kind: "changed",
          title: "No accepted artifact",
          detail: FACTORY_ARTIFACT_NOT_ACCEPTED,
        };
      case "artifact-too-large":
      case "artifact-not-text":
        return { kind: "error", title: "Can't post this deliverable", detail: error.message };
      case "destination-not-found":
        return {
          kind: "repository",
          title: "Issue not found",
          detail:
            "That number is not an issue in this project's repository. Check the number, then prepare again.",
        };
      case "capability-unsupported":
        return {
          kind: "unsupported",
          title: "Not supported",
          detail: factoryIssueCommentUnsupportedText(displayName),
        };
      default:
        return { kind: "error", title: "Couldn't post the comment", detail: error.message };
    }
  }
  return describeFactoryFailure(error, "Couldn't post the comment", displayName ?? undefined);
}
