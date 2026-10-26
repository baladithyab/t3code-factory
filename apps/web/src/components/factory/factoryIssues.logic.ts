import {
  EnvironmentAuthorizationError,
  FACTORY_READINESS_TTL_MS,
  FactoryIssueError,
  type EnvironmentId,
  type FactoryIssue,
  type FactoryIssueListInput,
  type FactoryIssueTask,
  type FactoryReadiness,
  type FactoryReadinessEdge,
  type FactoryReadinessReason,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { formatRelativeTimeLabel } from "../../timestampFormat";

export type FactoryIssueStateFilter = NonNullable<FactoryIssueListInput["state"]>;

export const FACTORY_STATE_FILTERS: ReadonlyArray<{
  readonly value: FactoryIssueStateFilter;
  readonly label: string;
}> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

export function parseFactoryStateFilter(value: unknown): FactoryIssueStateFilter {
  return value === "closed" || value === "all" ? value : "open";
}

type TaskBadgeVariant = "info" | "success" | "warning" | "error" | "secondary" | "outline";

export interface FactoryTaskPresentation {
  readonly label: string;
  readonly variant: TaskBadgeVariant;
  readonly detail: string;
}

/**
 * Labels mirror the server's own task status; nothing here infers progress it was not told about.
 */
export function factoryTaskPresentation(
  status: FactoryIssueTask["status"],
): FactoryTaskPresentation {
  switch (status) {
    case "launching":
      return {
        label: "Launch pending",
        variant: "warning",
        detail:
          "A launch was reserved but did not finish. Resume completes the same task with its original settings.",
      };
    case "preparing":
      return {
        label: "Preparing",
        variant: "info",
        detail: "The isolated worktree is being prepared.",
      };
    case "running":
      return { label: "Running", variant: "success", detail: "An agent is working on this task." };
    case "idle":
      return { label: "Idle", variant: "secondary", detail: "The task thread is waiting for you." };
    case "failed":
      return {
        label: "Failed",
        variant: "error",
        detail: "Setup or the last run failed. Open the thread to retry or inspect it.",
      };
    case "archived":
      return {
        label: "Archived",
        variant: "outline",
        detail: "The task thread is archived. Opening it does not start new work.",
      };
    case "missing":
      return {
        label: "Thread deleted",
        variant: "warning",
        detail: "The linked thread was deleted. A new attempt needs explicit confirmation.",
      };
  }
}

export type FactoryIssueAction =
  | { readonly kind: "start" }
  | { readonly kind: "resume" }
  | { readonly kind: "restart" }
  | { readonly kind: "open"; readonly task: FactoryIssueTask }
  | { readonly kind: "unavailable"; readonly reason: string };

/** A closed issue never begins new work, but a task that already exists stays reachable. */
export function resolveFactoryIssueAction(issue: FactoryIssue): FactoryIssueAction {
  const { task } = issue;
  if (task === null) {
    return issue.state === "open"
      ? { kind: "start" }
      : { kind: "unavailable", reason: "Closed issues cannot start new tasks." };
  }
  switch (task.status) {
    case "launching":
      return { kind: "resume" };
    case "missing":
      return issue.state === "open"
        ? { kind: "restart" }
        : { kind: "unavailable", reason: "Closed issues cannot start a new attempt." };
    default:
      return { kind: "open", task };
  }
}

export type FactoryFailureKind = "permission" | "unsupported" | "repository" | "changed" | "other";

export interface FactoryFailure {
  readonly kind: FactoryFailureKind;
  readonly title: string;
  readonly message: string;
  readonly reason: FactoryIssueError["reason"] | null;
}

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isFactoryIssueError = Schema.is(FactoryIssueError);

const GENERIC_FAILURE_MESSAGE = "The environment request failed.";

export function describeFactoryFailure(error: unknown, fallbackMessage?: string): FactoryFailure {
  if (isAuthorizationError(error)) {
    return {
      kind: "permission",
      title: "Permission required",
      message: error.message.trim() || "This connection lacks permission for factory issues.",
      reason: null,
    };
  }
  if (isFactoryIssueError(error)) {
    switch (error.reason) {
      case "issue-changed":
        return {
          kind: "changed",
          title: "Issue changed",
          message: error.message,
          reason: error.reason,
        };
      case "unsupported-provider":
        return {
          kind: "unsupported",
          title: "Repository not supported",
          message: error.message,
          reason: error.reason,
        };
      case "missing-repository":
      case "missing-project":
      case "repository-changed":
        return {
          kind: "repository",
          title: "Repository unavailable",
          message: error.message,
          reason: error.reason,
        };
      case "authentication":
        return {
          kind: "other",
          title: "GitHub sign-in required",
          message: error.message,
          reason: error.reason,
        };
      case "rate-limited":
        return {
          kind: "other",
          title: "GitHub rate limit reached",
          message: error.message,
          reason: error.reason,
        };
      default:
        return {
          kind: "other",
          title: "Could not complete the request",
          message: error.message,
          reason: error.reason,
        };
    }
  }
  const message =
    fallbackMessage ??
    (error instanceof Error && error.message.trim().length > 0
      ? error.message
      : GENERIC_FAILURE_MESSAGE);
  return { kind: "other", title: "Could not complete the request", message, reason: null };
}

/** An empty base ref means "current HEAD", which the server resolves; the client never guesses it. */
export function normalizeFactoryBaseRef(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Issue URLs come from a remote service and are untrusted; only http(s) becomes a link. */
export function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export const FACTORY_ISSUE_BODY_PREVIEW_LIMIT = 8_000;

export function boundedIssueBody(body: string | null): { text: string; truncated: boolean } {
  const text = body?.trim() ?? "";
  return text.length > FACTORY_ISSUE_BODY_PREVIEW_LIMIT
    ? { text: text.slice(0, FACTORY_ISSUE_BODY_PREVIEW_LIMIT), truncated: true }
    : { text, truncated: false };
}

/** Visited page numbers, last is current. Previous returns to the page that led here, not page-1. */
export function pushFactoryPage(
  pages: ReadonlyArray<number>,
  nextPage: number,
): ReadonlyArray<number> {
  return [...pages, nextPage];
}

export function popFactoryPage(pages: ReadonlyArray<number>): ReadonlyArray<number> {
  return pages.length <= 1 ? [1] : pages.slice(0, -1);
}

export function currentFactoryPage(pages: ReadonlyArray<number>): number {
  return pages.at(-1) ?? 1;
}

/** Every piece of inbox state is keyed by this, so changing scope can never show another scope's rows. */
export function factoryScopeKey(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  state: FactoryIssueStateFilter,
): string {
  return JSON.stringify([environmentId, projectId, state]);
}

export type FactoryReadinessTone = "success" | "warning" | "info" | "neutral";

export interface FactoryReadinessEdgeRow {
  /** Identity is the tracker's database id; repository and number are only a locator. */
  readonly key: string;
  readonly locator: string;
  readonly url: string | null;
  readonly title: string;
  readonly stateLabel: string;
  readonly closedAt: string | null;
  readonly resolutionLabel: string;
  readonly statusLabel: string;
}

export interface FactoryReadinessPresentation {
  readonly label: string;
  readonly tone: FactoryReadinessTone;
  readonly stale: boolean;
  readonly edgeRows: ReadonlyArray<FactoryReadinessEdgeRow>;
}

// Keyed by the contract's reason union, so a new server reason fails to compile here instead of
// reaching the screen as a raw token.
const READINESS_REASON_LABELS: Record<FactoryReadinessReason, string> = {
  "closed-subject": "the issue is closed",
  "open-blocker": "a blocker is still open",
  "unaccepted-blocker": "a blocker was closed without completion",
  "deleted-blocker": "a blocker was deleted",
  "inaccessible-blocker": "a blocker is not accessible",
  "moved-blocker": "a blocker moved",
  "unverified-blocker": "a blocker could not be verified",
  "partial-listing": "GitHub returned only part of the blocker list",
  "summary-missing": "GitHub did not report how many blockers exist",
  "truncated-response": "the blocker list was truncated",
  "invalid-response": "GitHub returned a response that could not be read",
  authentication: "GitHub sign-in is required",
  "rate-limited": "the GitHub rate limit was reached",
  "remote-failure": "GitHub could not be reached",
  cycle: "the blockers form a cycle",
};

function edgeStateLabel(edge: FactoryReadinessEdge): string {
  if (edge.state === "open") return "Open";
  if (edge.state === "closed") {
    // Reasons arrive as tracker tokens such as `not_planned`; show them as words.
    return edge.stateReason === null
      ? "Closed"
      : `Closed · ${edge.stateReason.replaceAll("_", " ")}`;
  }
  return "State unknown";
}

function edgeResolutionLabel(edge: FactoryReadinessEdge): string {
  // The tracker removed this dependency; that is its call and the server does not count it.
  if (edge.status === "removed-at-source") return "Not counted, removed at source";
  switch (edge.resolution) {
    case "accepted":
      return "Accepted";
    case "open":
      return "Open, unresolved";
    case "closed-unaccepted":
      return edge.stateReason === null
        ? "Closed, not accepted (no reason recorded)"
        : `Closed, not accepted (${edge.stateReason.replaceAll("_", " ")})`;
    case "deleted":
      return "Deleted, counts as unresolved";
    case "inaccessible":
      return "Inaccessible, cannot verify";
    case "moved":
      return "Moved, cannot verify";
    case "unverified":
      return "Could not be verified";
  }
}

function edgeStatusLabel(status: FactoryReadinessEdge["status"]): string {
  switch (status) {
    case "present":
      return "Listed";
    case "removed-at-source":
      return "No longer listed";
    case "deleted":
      return "Deleted at source";
    case "inaccessible":
      return "Inaccessible";
    case "moved":
      return "Moved";
    case "unverified":
      return "Unverified";
  }
}

function edgeRow(edge: FactoryReadinessEdge): FactoryReadinessEdgeRow {
  const title = edge.title?.trim() ?? "";
  return {
    key: `${edge.targetHost}:${edge.targetId}`,
    locator: `${edge.targetRepository}#${edge.targetNumber}`,
    url: safeExternalUrl(edge.targetUrl),
    title: title.length > 0 ? title : "Title unavailable",
    stateLabel: edgeStateLabel(edge),
    closedAt: edge.closedAt,
    resolutionLabel: edgeResolutionLabel(edge),
    statusLabel: edgeStatusLabel(edge.status),
  };
}

/**
 * Wording for observed blocker evidence. It never says "Ready": the line reports what was seen and
 * when, and nothing here gates starting work. A stale observation (or one whose time cannot be
 * read) is marked rather than hidden, and no longer reads as a positive signal.
 */
export function factoryReadinessPresentation(
  readiness: FactoryReadiness,
  now: number,
): FactoryReadinessPresentation {
  const stale = !(now - Date.parse(readiness.observedAt) <= FACTORY_READINESS_TTL_MS);
  let label: string;
  let tone: FactoryReadinessTone;
  switch (readiness.status) {
    case "ready": {
      const observed = formatRelativeTimeLabel(readiness.observedAt, now);
      label = `No unresolved blockers observed ${observed} · basis: source`;
      tone = stale ? "info" : "success";
      break;
    }
    case "blocked": {
      const unresolved = readiness.edges.filter(
        (edge) => edge.status !== "removed-at-source" && edge.resolution !== "accepted",
      ).length;
      label = `Blocked: ${unresolved} unresolved ${unresolved === 1 ? "blocker" : "blockers"}`;
      tone = "warning";
      break;
    }
    case "unknown": {
      const reason = readiness.reasons[0];
      label = `Readiness unknown: ${reason === undefined ? "no reason reported" : READINESS_REASON_LABELS[reason]}`;
      tone = "info";
      break;
    }
    case "not-applicable":
      label = "Not applicable (closed)";
      tone = "neutral";
      break;
  }
  return {
    label: stale ? `${label} · stale` : label,
    tone,
    stale,
    edgeRows: readiness.edges.map(edgeRow),
  };
}
