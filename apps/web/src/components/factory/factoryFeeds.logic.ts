import {
  EnvironmentAuthorizationError,
  FACTORY_FEED_INSTRUCTIONS_MAX_CHARS,
  FactoryFeedError,
  type CommandId,
  type FactoryFeedCandidate,
  type FactoryFeedCandidateAdmitInput,
  type FactoryFeedSource,
  type FactoryIssueTask,
  type FactoryRepository,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

type FeedBadgeVariant = "info" | "success" | "warning" | "error" | "secondary" | "outline";

export interface FactoryFeedBadge {
  readonly label: string;
  readonly variant: FeedBadgeVariant;
}

/**
 * A feed address is entered by the user and fetched by the server, so anything the server will
 * refuse anyway is rejected here without a round trip. The server owns the normalised locator.
 */
export type FactoryFeedUrlCheck =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly message: string };

export function checkFactoryFeedUrl(value: string): FactoryFeedUrlCheck {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, message: "Enter a feed address." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, message: "Enter an absolute https:// feed address." };
  }
  if (parsed.protocol !== "https:")
    return { ok: false, message: "Only https:// feeds can be bound." };
  if (parsed.username !== "" || parsed.password !== "")
    return { ok: false, message: "Feed addresses cannot contain credentials." };
  return { ok: true, url: trimmed };
}

export function describeFactoryFeedSource(source: FactoryFeedSource): {
  readonly badge: FactoryFeedBadge;
  readonly detail: string | null;
} {
  return source.status === "active"
    ? { badge: { label: "Active", variant: "success" }, detail: null }
    : {
        badge: { label: "Unbound", variant: "warning" },
        detail:
          "Unbound. Items and tasks are kept, but this feed is not checked. Bind the same address again to resume.",
      };
}

export type FactoryFeedRefreshAvailability =
  | { readonly kind: "ready" }
  | { readonly kind: "waiting"; readonly remainingMs: number; readonly label: string }
  | { readonly kind: "unbound" };

/** `Check now` follows the server's floor; the server still enforces it if the clock here is off. */
export function factoryFeedRefreshAvailability(
  source: Pick<FactoryFeedSource, "status" | "nextAllowedAt">,
  nowMs: number,
): FactoryFeedRefreshAvailability {
  if (source.status !== "active") return { kind: "unbound" };
  const allowedAt = source.nextAllowedAt === null ? Number.NaN : Date.parse(source.nextAllowedAt);
  if (Number.isNaN(allowedAt) || allowedAt <= nowMs) return { kind: "ready" };
  const remainingMs = allowedAt - nowMs;
  return { kind: "waiting", remainingMs, label: formatFactoryFeedCountdown(remainingMs) };
}

export function formatFactoryFeedCountdown(remainingMs: number): string {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

/** Dismissed items are hidden by default; retracted and unreviewable ones always stay visible. */
export function visibleFactoryFeedCandidates(
  candidates: ReadonlyArray<FactoryFeedCandidate>,
  sourceId: FactoryFeedSource["id"],
  showDismissed: boolean,
): ReadonlyArray<FactoryFeedCandidate> {
  return candidates.filter(
    (candidate) =>
      candidate.sourceId === sourceId && (showDismissed || candidate.disposition !== "dismissed"),
  );
}

export function factoryFeedCandidateBadges(
  candidate: FactoryFeedCandidate,
): ReadonlyArray<FactoryFeedBadge> {
  const badges: FactoryFeedBadge[] = [];
  switch (candidate.disposition) {
    case "dismissed":
      badges.push({ label: "Dismissed", variant: "secondary" });
      break;
    case "retracted":
      badges.push({ label: "Retracted by publisher", variant: "error" });
      break;
    case "unreviewable":
      badges.push({ label: "Unreviewable", variant: "error" });
      break;
    case "open":
      break;
  }
  if (!candidate.inWindow) badges.push({ label: "Not in current feed", variant: "outline" });
  if (candidate.ordinal > 1)
    badges.push({ label: `Edited · revision ${candidate.ordinal}`, variant: "info" });
  return badges;
}

/** Same comparison the server uses for `forge-issue-source`, so the row never promises more. */
export function pointsAtProjectIssue(
  candidate: Pick<FactoryFeedCandidate, "forgeReference">,
  repository: FactoryRepository | null,
): boolean {
  const reference = candidate.forgeReference;
  return (
    reference !== null &&
    repository !== null &&
    `${reference.host}/${reference.repository}` === repository.canonicalKey
  );
}

export type FactoryFeedCandidateAction =
  | { readonly kind: "admit" }
  | { readonly kind: "resume" }
  | { readonly kind: "restart" }
  | { readonly kind: "open"; readonly task: FactoryIssueTask }
  | { readonly kind: "project-issue" }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Why new work cannot start from this item, in the server's own guard order. */
function newWorkBlock(
  candidate: FactoryFeedCandidate,
  source: FactoryFeedSource,
  repository: FactoryRepository | null,
): FactoryFeedCandidateAction | null {
  if (repository === null)
    return {
      kind: "unavailable",
      reason: "This project has no GitHub repository, so feed items cannot start tasks.",
    };
  switch (candidate.disposition) {
    case "retracted":
      return { kind: "unavailable", reason: "The publisher retracted this item." };
    case "unreviewable":
      return {
        kind: "unavailable",
        reason:
          "This item has no stable identity or exceeds the size bounds, so it cannot be reviewed.",
      };
    case "dismissed":
      return { kind: "unavailable", reason: "Dismissed. Restore it to review it for admission." };
    case "open":
      break;
  }
  if (source.status !== "active")
    return { kind: "unavailable", reason: "This source is unbound. Bind it again to admit items." };
  if (pointsAtProjectIssue(candidate, repository)) return { kind: "project-issue" };
  return null;
}

/**
 * An existing task always stays reachable. New work needs an open, reviewable item on an active
 * source whose reference is not one of this project's own issues.
 */
export function resolveFactoryFeedCandidateAction(
  candidate: FactoryFeedCandidate,
  context: {
    readonly source: FactoryFeedSource;
    readonly repository: FactoryRepository | null;
  },
): FactoryFeedCandidateAction {
  const { task } = candidate;
  if (task === null)
    return newWorkBlock(candidate, context.source, context.repository) ?? { kind: "admit" };
  switch (task.status) {
    case "launching":
      // The server resumes a reserved launch from its frozen intent before any other guard.
      return context.repository === null
        ? {
            kind: "unavailable",
            reason: "This project has no GitHub repository, so the launch cannot resume.",
          }
        : { kind: "resume" };
    case "missing":
      return newWorkBlock(candidate, context.source, context.repository) ?? { kind: "restart" };
    default:
      return { kind: "open", task };
  }
}

export type FactoryFeedDismissalAction = "dismiss" | "restore" | null;

/** A candidate with a task keeps its row; a retracted or unreviewable one has nothing to restore. */
export function resolveFactoryFeedDismissal(
  candidate: Pick<FactoryFeedCandidate, "disposition" | "task">,
): FactoryFeedDismissalAction {
  switch (candidate.disposition) {
    case "open":
      return candidate.task === null ? "dismiss" : null;
    case "dismissed":
      return "restore";
    case "retracted":
    case "unreviewable":
      return null;
  }
}

export interface FactoryFeedTextCount {
  readonly length: number;
  readonly label: string;
  readonly overLimit: boolean;
}

/** The server bounds reviewer text by string length, so the counter counts the same units. */
export function countFactoryFeedText(value: string, max: number): FactoryFeedTextCount {
  return {
    length: value.length,
    label: `${value.length} / ${max}`,
    overLimit: value.length > max,
  };
}

/** Reviewer text is sent exactly as typed; only an entirely blank field is omitted. */
export function normalizeFactoryFeedText(value: string): string | undefined {
  return value.trim().length === 0 ? undefined : value;
}

export interface FactoryFeedAdmitReadiness {
  readonly canAdmit: boolean;
  readonly pending: boolean;
  readonly changed: boolean;
  readonly selection: ModelSelection | null;
  readonly instructions: string;
}

/** `changed` locks resubmission: the pinned snapshot is stale and must be reviewed again. */
export function isFactoryFeedAdmitEnabled(readiness: FactoryFeedAdmitReadiness): boolean {
  return (
    readiness.canAdmit &&
    !readiness.pending &&
    !readiness.changed &&
    readiness.selection !== null &&
    !countFactoryFeedText(readiness.instructions, FACTORY_FEED_INSTRUCTIONS_MAX_CHARS).overLimit
  );
}

export function buildFactoryFeedAdmitInput(options: {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly repository: FactoryRepository;
  readonly candidate: Pick<FactoryFeedCandidate, "sourceId" | "itemKey" | "revision">;
  readonly modelSelection: ModelSelection;
  readonly instructions: string;
  readonly baseRef: string | undefined;
  readonly runtimeMode: FactoryFeedCandidateAdmitInput["runtimeMode"];
  readonly interactionMode: FactoryFeedCandidateAdmitInput["interactionMode"];
  readonly restartDeleted: boolean;
}): FactoryFeedCandidateAdmitInput {
  const instructions = normalizeFactoryFeedText(options.instructions);
  return {
    commandId: options.commandId,
    projectId: options.projectId,
    expectedRepositoryKey: options.repository.canonicalKey,
    sourceId: options.candidate.sourceId,
    itemKey: options.candidate.itemKey,
    // The revision the reviewer saw, never one read again at submit time.
    expectedRevision: options.candidate.revision,
    modelSelection: options.modelSelection,
    runtimeMode: options.runtimeMode,
    interactionMode: options.interactionMode,
    ...(instructions !== undefined ? { instructions } : {}),
    ...(options.baseRef !== undefined ? { baseRef: options.baseRef } : {}),
    ...(options.restartDeleted ? { restartDeleted: true } : {}),
  };
}

export type FactoryFeedFailureKind =
  | "permission"
  | "repository"
  | "changed"
  | "throttled"
  | "other";

export interface FactoryFeedFailure {
  readonly kind: FactoryFeedFailureKind;
  readonly title: string;
  readonly message: string;
  readonly reason: FactoryFeedError["reason"] | null;
}

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isFactoryFeedError = Schema.is(FactoryFeedError);

const GENERIC_FAILURE_MESSAGE = "The environment request failed.";

export function describeFactoryFeedFailure(
  error: unknown,
  fallbackMessage?: string,
): FactoryFeedFailure {
  if (isAuthorizationError(error)) {
    return {
      kind: "permission",
      title: "Permission required",
      message: error.message.trim() || "This connection lacks permission for feed sources.",
      reason: null,
    };
  }
  if (isFactoryFeedError(error)) {
    const { reason, message } = error;
    switch (reason) {
      case "candidate-changed":
        return { kind: "changed", title: "Item changed", message, reason };
      case "missing-project":
      case "missing-repository":
      case "unsupported-provider":
      case "repository-changed":
        return { kind: "repository", title: "Repository unavailable", message, reason };
      case "refresh-throttled":
        return { kind: "throttled", title: "Checked too recently", message, reason };
      case "invalid-url":
      case "unsafe-host":
        return { kind: "other", title: "Feed address rejected", message, reason };
      case "feed-unavailable":
      case "feed-too-large":
      case "invalid-feed":
        return { kind: "other", title: "Feed could not be read", message, reason };
      case "missing-source":
      case "source-suspended":
      case "source-exists":
        return { kind: "other", title: "Feed source unavailable", message, reason };
      case "missing-candidate":
      case "candidate-dismissed":
      case "candidate-retracted":
      case "candidate-unreviewable":
      case "forge-issue-source":
        return { kind: "other", title: "Item cannot be admitted", message, reason };
      case "origin-conflict":
        // Older records already claim this item more than once; the server keeps them all.
        return { kind: "other", title: "Item claimed more than once", message, reason };
      default:
        return { kind: "other", title: "Could not complete the request", message, reason };
    }
  }
  const message =
    fallbackMessage ??
    (error instanceof Error && error.message.trim().length > 0
      ? error.message
      : GENERIC_FAILURE_MESSAGE);
  return { kind: "other", title: "Could not complete the request", message, reason: null };
}
