import {
  EnvironmentAuthorizationError,
  FACTORY_RESEARCH_ARTIFACT_INLINE_MAX_BYTES,
  FACTORY_RESEARCH_EVALUATOR_MAX_PATHS,
  FACTORY_RESEARCH_HYPOTHESIS_MAX_CHARS,
  FACTORY_RESEARCH_INSTRUCTIONS_MAX_CHARS,
  FACTORY_RESEARCH_RUN_COMMAND_MAX_CHARS,
  FactoryResearchError,
  type CommandId,
  type FactoryRepository,
  type FactoryResearchDisposition,
  type FactoryResearchFinding,
  type FactoryResearchFindingReason,
  type FactoryResearchMetricSpec,
  type FactoryResearchImplementationAdmitInput,
  type FactoryResearchObservation,
  type FactoryResearchProtocol,
  type FactoryResearchProtocolId,
  type FactoryResearchProtocolSealInput,
  type FactoryResearchRunLaunchInput,
  type FactoryResearchRun,
  type FactoryResearchRunRole,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  countFactoryFeedText,
  formatFactoryFeedCountdown,
  normalizeFactoryFeedText,
} from "./factoryFeeds.logic";
import {
  factoryTaskPresentation,
  normalizeFactoryBaseRef,
  type FactoryTaskPresentation,
} from "./factoryIssues.logic";

type ResearchBadgeVariant = "info" | "success" | "warning" | "error" | "secondary" | "outline";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Values come from run output; trimming float noise keeps `0.95 - 0.93` from reading `0.02000…18`. */
export function formatFactoryResearchNumber(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/** A commit is shown abbreviated; the full id stays available to the caller for a title or copy. */
export function shortFactoryCommit(commit: string): string {
  return commit.length > 12 ? commit.slice(0, 12) : commit;
}

function formatRemaining(remainingMs: number): string {
  if (remainingMs < MS_PER_DAY) return formatFactoryFeedCountdown(remainingMs);
  const days = Math.floor(remainingMs / MS_PER_DAY);
  const hours = Math.floor((remainingMs % MS_PER_DAY) / MS_PER_HOUR);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

function directionLabel(direction: FactoryResearchMetricSpec["direction"]): string {
  return direction === "lower" ? "Lower is better" : "Higher is better";
}

export interface FactoryProtocolPresentation {
  readonly metricLabel: string;
  readonly ruleLabel: string;
  readonly budget: {
    readonly runsLabel: string;
    readonly runMinutesLabel: string;
    /** True once the sealed window has closed, or when the sealed time cannot be read. */
    readonly expired: boolean;
    readonly remainingMs: number | null;
    readonly label: string;
  };
  readonly evaluators: FactoryResearchProtocol["evaluators"];
}

/**
 * Everything shown here was sealed by the server; nothing is derived from a clock except whether
 * the window is still open, which the server re-checks at launch.
 */
export function factoryProtocolPresentation(
  protocol: FactoryResearchProtocol,
  now: number,
): FactoryProtocolPresentation {
  const { metric, budget } = protocol;
  const expiresAt = Date.parse(budget.expiresAt);
  const readable = !Number.isNaN(expiresAt);
  const remainingMs = readable && expiresAt > now ? expiresAt - now : null;
  return {
    metricLabel: `${metric.name} · line prefix ${metric.linePrefix} · ${directionLabel(metric.direction)}`,
    ruleLabel:
      metric.minimumEffect === null
        ? "No minimum effect was declared, so no result can be judged and the finding stays unknown."
        : `A result counts only if it is ${formatFactoryResearchNumber(metric.minimumEffect)} or more ${
            metric.direction === "lower" ? "below" : "above"
          } the measured baseline.`,
    budget: {
      runsLabel: `${budget.maxRuns} ${budget.maxRuns === 1 ? "run" : "runs"}`,
      runMinutesLabel: `${budget.maxRunMinutes} min per run`,
      expired: remainingMs === null,
      remainingMs,
      label: !readable
        ? "Budget window unreadable"
        : remainingMs === null
          ? "Budget window expired"
          : `Window closes in ${formatRemaining(remainingMs)}`,
    },
    evaluators: protocol.evaluators,
  };
}

const DISPOSITION_LABELS: Record<
  FactoryResearchDisposition,
  { readonly label: string; readonly variant: ResearchBadgeVariant }
> = {
  acceptable: { label: "Acceptable", variant: "success" },
  "evaluator-changed": { label: "Evaluator changed", variant: "error" },
  "not-descendant": { label: "Not a descendant", variant: "error" },
  "citation-invalid": { label: "Citation invalid", variant: "error" },
  "over-budget": { label: "Over budget", variant: "error" },
  unknown: { label: "Unknown", variant: "secondary" },
};

export interface FactoryArtifactRow {
  readonly key: string;
  readonly path: string;
  readonly line: number;
  readonly sha256: string;
  readonly bytes: number;
  readonly retentionLabel: string;
  readonly lineText: string | null;
}

export interface FactoryObservationPresentation {
  readonly dispositionLabel: string;
  readonly variant: ResearchBadgeVariant;
  readonly acceptable: boolean;
  /** Why the server did not accept the evidence; empty when it did. */
  readonly reasons: ReadonlyArray<string>;
  readonly metric: string | null;
  readonly usage: string;
  readonly artifacts: ReadonlyArray<FactoryArtifactRow>;
  readonly missing: ReadonlyArray<string>;
}

function formatKibibytes(bytes: number): string {
  return `${Math.round(bytes / 1024)} KiB`;
}

function dispositionReasons(
  observation: FactoryResearchObservation,
  protocol: Pick<FactoryResearchProtocol, "budget">,
): ReadonlyArray<string> {
  switch (observation.disposition) {
    case "acceptable":
      return [];
    case "evaluator-changed": {
      const changed = observation.evaluators.filter((evaluator) => !evaluator.matchesSealed);
      return changed.length === 0
        ? ["An evaluator no longer matches the sealed protocol."]
        : changed.map(({ path, blobOid }) =>
            blobOid === null
              ? `${path} could not be read at this commit, so it cannot match the sealed copy.`
              : `${path} differs from the copy sealed in the protocol.`,
          );
    }
    case "not-descendant":
      return ["This commit is not a descendant of the protocol's base commit."];
    case "citation-invalid": {
      const unreadable = observation.artifacts
        .filter((artifact) => artifact.lineText === null)
        .map(({ path, line }) => `${path}:${line} does not exist in the run's files.`);
      return [
        ...unreadable,
        ...(observation.metricValue === null
          ? ["No metric value could be read from the cited lines."]
          : []),
      ];
    }
    case "over-budget":
      return [
        `The run recorded ${observation.runCount} ${observation.runCount === 1 ? "run" : "runs"} and ${observation.elapsedMinutes} min against a sealed limit of ${protocol.budget.maxRuns} ${protocol.budget.maxRuns === 1 ? "run" : "runs"} and ${protocol.budget.maxRunMinutes} min. Over-budget evidence is never admissible, whatever the metric.`,
      ];
    case "unknown":
      return [
        ...(observation.ancestorOfBase === null
          ? ["The ancestry check against the base commit could not run."]
          : []),
        ...observation.evaluators
          .filter((evaluator) => evaluator.blobOid === null)
          .map(({ path }) => `${path} could not be read at this commit.`),
      ];
  }
}

export function factoryObservationPresentation(
  observation: FactoryResearchObservation,
  protocol: Pick<FactoryResearchProtocol, "metric" | "budget">,
): FactoryObservationPresentation {
  const disposition = DISPOSITION_LABELS[observation.disposition];
  const reasons = dispositionReasons(observation, protocol);
  return {
    dispositionLabel: disposition.label,
    variant: disposition.variant,
    acceptable: observation.disposition === "acceptable",
    reasons:
      observation.disposition === "unknown" && reasons.length === 0
        ? ["The server could not derive a verdict from this evidence."]
        : reasons,
    metric:
      observation.metricValue === null
        ? null
        : `${protocol.metric.name} ${formatFactoryResearchNumber(observation.metricValue)}`,
    usage: `${observation.runCount} ${observation.runCount === 1 ? "run" : "runs"} · ${observation.elapsedMinutes} min`,
    artifacts: observation.artifacts.map((artifact) => ({
      key: `${artifact.path}:${artifact.line}`,
      path: artifact.path,
      line: artifact.line,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      retentionLabel:
        artifact.retention === "inline"
          ? "Retained in full"
          : `Digest only (over ${formatKibibytes(FACTORY_RESEARCH_ARTIFACT_INLINE_MAX_BYTES)})`,
      lineText: artifact.lineText,
    })),
    missing: observation.missing,
  };
}

const FINDING_STATUS: Record<
  FactoryResearchFinding["status"],
  { readonly label: string; readonly variant: ResearchBadgeVariant }
> = {
  supported: { label: "Supported", variant: "success" },
  unsupported: { label: "Unsupported", variant: "warning" },
  unknown: { label: "Unknown", variant: "secondary" },
};

export const FACTORY_RESEARCH_FINDING_REASONS: Record<FactoryResearchFindingReason, string> = {
  "rule-not-declared":
    "The protocol sealed no minimum effect, so no result can be judged. Seal a new protocol that declares one.",
  "baseline-missing":
    "No acceptable run has measured the baseline at the protocol's base commit yet.",
  "explore-missing": "No acceptable explore run has recorded a result yet.",
  "verification-missing":
    "No acceptable verification has measured the selected commit. Launch one from this page.",
  "verification-not-independent":
    "The verification was launched by the thread that produced the result. Launch it again from this page.",
  "run-not-acceptable":
    "A run's evidence was not accepted. Its disposition below says why; the metric alone never decides.",
  "effect-below-minimum": "A measured result does not clear the sealed minimum effect.",
  "protocol-expired": "The protocol's budget window has closed. Seal a new protocol to run more.",
};

export interface FactoryFindingValueRow {
  readonly key: "baseline" | "explore" | "verify";
  readonly label: string;
  readonly value: string;
  /** Distance from the baseline in the sealed direction; null for the baseline itself. */
  readonly effect: string | null;
  readonly threadId: FactoryResearchFinding["baselineThreadId"];
}

export interface FactoryFindingPresentation {
  readonly statusLabel: string;
  readonly variant: ResearchBadgeVariant;
  readonly reasons: ReadonlyArray<{
    readonly reason: FactoryResearchFindingReason;
    readonly text: string;
  }>;
  readonly values: ReadonlyArray<FactoryFindingValueRow>;
  readonly selectedCommit: string | null;
  readonly minimumEffect: string;
  readonly direction: string;
  readonly varianceNote: string;
}

function effectLabel(
  value: number,
  baseline: number,
  direction: FactoryResearchMetricSpec["direction"],
): string {
  const better = direction === "lower" ? baseline - value : value - baseline;
  if (better === 0) return "no change from the baseline";
  return `${formatFactoryResearchNumber(Math.abs(better))} ${better > 0 ? "better" : "worse"} than the baseline`;
}

/**
 * The server derives status and reasons on each read. This only words them and measures each value
 * against the baseline in the sealed direction, so a lower-is-better metric never reads backwards.
 */
export function factoryFindingPresentation(
  finding: FactoryResearchFinding,
  metric: FactoryResearchMetricSpec,
): FactoryFindingPresentation {
  const status = FINDING_STATUS[finding.status];
  const row = (
    key: FactoryFindingValueRow["key"],
    label: string,
    value: number | null,
    threadId: FactoryFindingValueRow["threadId"],
  ): FactoryFindingValueRow => ({
    key,
    label,
    value: value === null ? "Not measured" : formatFactoryResearchNumber(value),
    effect:
      key === "baseline" || value === null || finding.baselineValue === null
        ? null
        : effectLabel(value, finding.baselineValue, metric.direction),
    threadId,
  });
  return {
    statusLabel: status.label,
    variant: status.variant,
    reasons: finding.reasons.map((reason) => ({
      reason,
      text: FACTORY_RESEARCH_FINDING_REASONS[reason],
    })),
    values: [
      row("baseline", "Baseline", finding.baselineValue, finding.baselineThreadId),
      row("explore", "Explore", finding.exploreValue, finding.exploreThreadId),
      row("verify", "Verify", finding.verifyValue, finding.verifyThreadId),
    ],
    selectedCommit: finding.selectedCommit,
    minimumEffect:
      metric.minimumEffect === null
        ? "None declared"
        : formatFactoryResearchNumber(metric.minimumEffect),
    direction: directionLabel(metric.direction),
    varianceNote: "One run per role. Variance is unmeasured, so a small effect may be noise.",
  };
}

const ROLE_LABELS: Record<FactoryResearchRunRole, string> = {
  explore: "Explore",
  verify: "Verify",
  implementation: "Implementation",
};

export interface FactoryRunPresentation {
  readonly key: string;
  readonly roleLabel: string;
  readonly role: FactoryResearchRunRole;
  readonly threadId: FactoryResearchRun["threadId"];
  readonly task: FactoryTaskPresentation;
  readonly commit: string | null;
  readonly observation: FactoryObservationPresentation | null;
  /** True when this run was sealed under an older revision than the protocol now carries. */
  readonly staleRevision: boolean;
  /** An implementation task is ordinary work; only explore and verify runs record evidence. */
  readonly recordsEvidence: boolean;
}

/** Chronological, so the table reads baseline, then candidates, then verification. */
export function factoryRunPresentations(
  runs: ReadonlyArray<FactoryResearchRun>,
  protocol: Pick<FactoryResearchProtocol, "metric" | "budget" | "revision">,
): ReadonlyArray<FactoryRunPresentation> {
  return runs
    .toSorted(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.threadId.localeCompare(right.threadId),
    )
    .map((run) => ({
      key: run.threadId,
      roleLabel: ROLE_LABELS[run.role],
      role: run.role,
      threadId: run.threadId,
      task: factoryTaskPresentation(run.task.status),
      commit: run.observation?.commit ?? null,
      observation:
        run.observation === null ? null : factoryObservationPresentation(run.observation, protocol),
      staleRevision: run.protocolRevision !== protocol.revision,
      recordsEvidence: run.role !== "implementation",
    }));
}

export interface FactoryResearchPermissions {
  /** Operate plus source-control write, the pair the server enforces for a launch. */
  readonly canLaunch: boolean;
  readonly canAdmit: boolean;
}

export interface FactoryResearchAction {
  readonly enabled: boolean;
  /** Why the action is unavailable; null when it is enabled. */
  readonly reason: string | null;
}

export interface FactoryResearchActions {
  readonly launchExplore: FactoryResearchAction;
  readonly launchVerify: FactoryResearchAction & {
    /** The candidate commit the verification would be pinned to. */
    readonly targetCommit: string | null;
  };
  readonly admitImplementation: FactoryResearchAdmitAction;
}

/**
 * What the admit button does. The server keeps one implementation per protocol: admitting again
 * returns the existing thread, resumes an interrupted launch, or, only after the thread was
 * deleted and the reviewer confirms, starts a new attempt.
 */
export type FactoryResearchAdmitMode = "admit" | "resume" | "restart" | "open";

export interface FactoryResearchAdmitAction extends FactoryResearchAction {
  readonly mode: FactoryResearchAdmitMode;
  /** The existing implementation task, for every mode except `admit`. */
  readonly task: FactoryResearchRun["task"] | null;
}

const ENABLED: FactoryResearchAction = { enabled: true, reason: null };

function disabled(reason: string): FactoryResearchAction {
  return { enabled: false, reason };
}

function latestImplementation(runs: ReadonlyArray<FactoryResearchRun>): FactoryResearchRun | null {
  const implementations = runs
    .filter((run) => run.role === "implementation")
    .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return implementations[0] ?? null;
}

function admitAction(
  finding: FactoryResearchFinding,
  implementation: FactoryResearchRun | null,
  permissions: FactoryResearchPermissions,
): FactoryResearchAdmitAction {
  const status = implementation?.task.status;
  const mode: FactoryResearchAdmitMode =
    implementation === null
      ? "admit"
      : status === "launching"
        ? "resume"
        : status === "missing"
          ? "restart"
          : "open";
  const task = implementation?.task ?? null;
  // Opening an existing implementation reads nothing new and needs no grant or fresh finding.
  if (mode === "open") return { ...ENABLED, mode, task };
  const block = !permissions.canAdmit
    ? "Admitting needs orchestration operate and source control write access."
    : finding.status !== "supported"
      ? "Only a supported finding can be admitted as implementation work."
      : null;
  return { ...(block === null ? ENABLED : disabled(block)), mode, task };
}

/** The candidate under test: the one the finding selected, else the latest acceptable explore. */
function verifyTarget(
  protocol: Pick<FactoryResearchProtocol, "baseCommit">,
  finding: FactoryResearchFinding,
  runs: ReadonlyArray<FactoryResearchRun>,
): string | null {
  if (finding.selectedCommit !== null) return finding.selectedCommit;
  const candidates = runs
    .flatMap((run) =>
      run.role === "explore" &&
      run.observation !== null &&
      run.observation.disposition === "acceptable" &&
      // The base commit is the baseline measurement, not a candidate to verify.
      run.observation.commit !== protocol.baseCommit
        ? [run.observation]
        : [],
    )
    .toSorted((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt));
  return candidates[0]?.commit ?? null;
}

/**
 * Which research actions to offer. Every refusal here is one the server also makes; the buttons
 * only explain it sooner, and the server still decides.
 */
export function researchActionsFor(
  protocol: FactoryResearchProtocol,
  finding: FactoryResearchFinding,
  runs: ReadonlyArray<FactoryResearchRun>,
  permissions: FactoryResearchPermissions,
  now: number,
): FactoryResearchActions {
  const expired = factoryProtocolPresentation(protocol, now).budget.expired;
  const implementation = latestImplementation(runs);
  // Explore and verify launches spend the same sealed run budget; implementations do not.
  const spent = runs.filter((run) => run.role === "explore" || run.role === "verify").length;
  const grantBlock = permissions.canLaunch
    ? null
    : "Launching needs orchestration operate and source control write access.";
  const budgetBlock = expired
    ? "The protocol's budget window has closed. Seal a new protocol to run more."
    : spent >= protocol.budget.maxRuns
      ? `All ${protocol.budget.maxRuns} runs of the sealed budget are used. Seal a new protocol to run more.`
      : null;
  const launchBlock = grantBlock ?? budgetBlock;

  const targetCommit = verifyTarget(protocol, finding, runs);
  const alreadyVerified =
    targetCommit !== null &&
    runs.some(
      (run) =>
        run.role === "verify" &&
        run.observation !== null &&
        run.observation.disposition === "acceptable" &&
        run.observation.commit === targetCommit,
    );
  // A missing candidate or an existing verification is the more useful explanation than a spent
  // budget, since neither can be fixed by launching.
  const verifyBlock =
    grantBlock ??
    (finding.exploreThreadId === null || targetCommit === null
      ? "Verification needs an acceptable explore run on a candidate commit first."
      : alreadyVerified
        ? "This commit already has an acceptable verification."
        : budgetBlock);

  return {
    launchExplore: launchBlock === null ? ENABLED : disabled(launchBlock),
    launchVerify: { ...(verifyBlock === null ? ENABLED : disabled(verifyBlock)), targetCommit },
    admitImplementation: admitAction(finding, implementation, permissions),
  };
}

export interface FactoryResearchSealDraft {
  readonly hypothesis: string;
  readonly runCommand: string;
  /** One repository-relative path per line. */
  readonly evaluatorPaths: string;
  readonly metricName: string;
  readonly linePrefix: string;
  readonly direction: FactoryResearchMetricSpec["direction"];
  /** Empty means no decision rule was declared. */
  readonly minimumEffect: string;
  readonly maxRuns: string;
  readonly maxRunMinutes: string;
  /** A `datetime-local` value (local time) or any ISO timestamp. */
  readonly expiresAt: string;
  readonly baseRef: string;
}

export const EMPTY_FACTORY_RESEARCH_SEAL_DRAFT: FactoryResearchSealDraft = {
  hypothesis: "",
  runCommand: "",
  evaluatorPaths: "",
  metricName: "",
  linePrefix: "",
  direction: "lower",
  minimumEffect: "",
  maxRuns: "3",
  maxRunMinutes: "30",
  expiresAt: "",
  baseRef: "",
};

export type FactoryResearchSealField = keyof FactoryResearchSealDraft;
export type FactoryResearchSealErrors = Partial<Record<FactoryResearchSealField, string>>;

export interface FactoryResearchSealFields {
  readonly hypothesis: string;
  readonly runCommand: string;
  readonly evaluatorPaths: ReadonlyArray<string>;
  readonly metric: FactoryResearchMetricSpec;
  readonly budget: FactoryResearchProtocolSealInput["budget"];
  readonly baseRef: string | undefined;
}

export type FactoryResearchSealCheck =
  | { readonly ok: true; readonly fields: FactoryResearchSealFields }
  | { readonly ok: false; readonly errors: FactoryResearchSealErrors };

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

function parsePositiveInt(value: string, label: string): number | string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return `${label} must be a whole number of at least 1.`;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 1
    ? parsed
    : `${label} must be a whole number of at least 1.`;
}

/** Repository-relative, forward-slash paths only; the server resolves them at the base commit. */
function evaluatorPathProblem(path: string): string | null {
  if (path.includes("\\")) return `${path}: use forward slashes.`;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return `${path}: use a path relative to the repository root.`;
  }
  if (path.split("/").some((segment) => segment === "..")) {
    return `${path}: a path cannot leave the repository.`;
  }
  return null;
}

export function splitFactoryResearchEvaluatorPaths(value: string): ReadonlyArray<string> {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Sealing is irreversible, so everything the server will refuse for shape is refused here without
 * a round trip. Whether an evaluator exists at the base commit is only the server's to know.
 */
export function checkFactoryResearchSealDraft(
  draft: FactoryResearchSealDraft,
  now: number,
): FactoryResearchSealCheck {
  const errors: { -readonly [Field in FactoryResearchSealField]?: string } = {};

  const hypothesis = draft.hypothesis.trim();
  if (hypothesis.length === 0)
    errors.hypothesis = "State the hypothesis in one falsifiable sentence.";
  else if (hypothesis.length > FACTORY_RESEARCH_HYPOTHESIS_MAX_CHARS) {
    errors.hypothesis = `The hypothesis is limited to ${FACTORY_RESEARCH_HYPOTHESIS_MAX_CHARS} characters.`;
  }

  const runCommand = draft.runCommand.trim();
  if (runCommand.length === 0) errors.runCommand = "Enter the command a run executes.";
  else if (runCommand.length > FACTORY_RESEARCH_RUN_COMMAND_MAX_CHARS) {
    errors.runCommand = `The run command is limited to ${FACTORY_RESEARCH_RUN_COMMAND_MAX_CHARS} characters.`;
  }

  const evaluatorPaths = splitFactoryResearchEvaluatorPaths(draft.evaluatorPaths);
  const duplicate = evaluatorPaths.find((path, index) => evaluatorPaths.indexOf(path) !== index);
  const malformed = evaluatorPaths.map(evaluatorPathProblem).find((problem) => problem !== null);
  if (evaluatorPaths.length === 0) {
    errors.evaluatorPaths = "List at least one evaluator path, one per line.";
  } else if (evaluatorPaths.length > FACTORY_RESEARCH_EVALUATOR_MAX_PATHS) {
    errors.evaluatorPaths = `At most ${FACTORY_RESEARCH_EVALUATOR_MAX_PATHS} evaluator paths can be sealed.`;
  } else if (malformed !== undefined && malformed !== null) {
    errors.evaluatorPaths = malformed;
  } else if (duplicate !== undefined) {
    errors.evaluatorPaths = `${duplicate} is listed more than once.`;
  }

  const metricName = draft.metricName.trim();
  if (metricName.length === 0) errors.metricName = "Name the metric.";
  const linePrefix = draft.linePrefix.trim();
  if (linePrefix.length === 0) {
    errors.linePrefix = "Enter the text that precedes the number on the cited line.";
  }

  const minimumEffectText = draft.minimumEffect.trim();
  let minimumEffect: number | null = null;
  if (minimumEffectText.length > 0) {
    const parsed = DECIMAL.test(minimumEffectText) ? Number(minimumEffectText) : Number.NaN;
    if (!Number.isFinite(parsed)) errors.minimumEffect = "Enter a number, or leave it empty.";
    else if (parsed < 0) errors.minimumEffect = "The minimum effect cannot be negative.";
    else minimumEffect = parsed;
  }

  const maxRuns = parsePositiveInt(draft.maxRuns, "Maximum runs");
  if (typeof maxRuns === "string") errors.maxRuns = maxRuns;
  const maxRunMinutes = parsePositiveInt(draft.maxRunMinutes, "Maximum minutes per run");
  if (typeof maxRunMinutes === "string") errors.maxRunMinutes = maxRunMinutes;

  const expiresAtText = draft.expiresAt.trim();
  const expiresAtMs = expiresAtText.length === 0 ? Number.NaN : Date.parse(expiresAtText);
  if (expiresAtText.length === 0) errors.expiresAt = "Choose when the budget window closes.";
  else if (Number.isNaN(expiresAtMs)) errors.expiresAt = "Enter a valid date and time.";
  else if (expiresAtMs <= now) errors.expiresAt = "The budget window must close in the future.";

  if (
    Object.keys(errors).length > 0 ||
    typeof maxRuns === "string" ||
    typeof maxRunMinutes === "string"
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    fields: {
      hypothesis,
      runCommand,
      evaluatorPaths,
      metric: { name: metricName, linePrefix, direction: draft.direction, minimumEffect },
      budget: {
        maxRuns,
        maxRunMinutes,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
      baseRef: normalizeFactoryBaseRef(draft.baseRef),
    },
  };
}

export function buildFactoryResearchSealInput(options: {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly repository: FactoryRepository;
  readonly fields: FactoryResearchSealFields;
}): FactoryResearchProtocolSealInput {
  const { fields } = options;
  return {
    commandId: options.commandId,
    projectId: options.projectId,
    expectedRepositoryKey: options.repository.canonicalKey,
    hypothesis: fields.hypothesis,
    runCommand: fields.runCommand,
    evaluatorPaths: fields.evaluatorPaths,
    metric: fields.metric,
    budget: fields.budget,
    ...(fields.baseRef !== undefined ? { baseRef: fields.baseRef } : {}),
  };
}

export interface FactoryResearchSubmitReadiness {
  /** Permission and the action's own availability, already combined by the caller. */
  readonly allowed: boolean;
  readonly pending: boolean;
  /** `protocol-changed` or `finding-changed`: the pinned revision is stale and locks resubmission. */
  readonly changed: boolean;
  readonly selection: ModelSelection | null;
  readonly instructions: string;
}

export function isFactoryResearchSubmitEnabled(readiness: FactoryResearchSubmitReadiness): boolean {
  return (
    readiness.allowed &&
    !readiness.pending &&
    !readiness.changed &&
    readiness.selection !== null &&
    !countFactoryFeedText(readiness.instructions, FACTORY_RESEARCH_INSTRUCTIONS_MAX_CHARS).overLimit
  );
}

/** Reviewer text is sent exactly as typed; only an entirely blank field is omitted. */
export function buildFactoryResearchLaunchInput(options: {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly repository: FactoryRepository;
  /** The id and revision the reviewer saw, never ones read again at submit time. */
  readonly protocol: Pick<FactoryResearchProtocol, "id" | "revision">;
  readonly role: FactoryResearchRunLaunchInput["role"];
  readonly targetCommit: string | null;
  readonly modelSelection: ModelSelection;
  readonly instructions: string;
  readonly runtimeMode: FactoryResearchRunLaunchInput["runtimeMode"];
  readonly interactionMode: FactoryResearchRunLaunchInput["interactionMode"];
}): FactoryResearchRunLaunchInput {
  const instructions = normalizeFactoryFeedText(options.instructions);
  return {
    commandId: options.commandId,
    projectId: options.projectId,
    expectedRepositoryKey: options.repository.canonicalKey,
    protocolId: options.protocol.id,
    expectedProtocolRevision: options.protocol.revision,
    role: options.role,
    // An explore run starts from the sealed base commit; only a verification names a candidate.
    ...(options.role === "verify" && options.targetCommit !== null
      ? { targetCommit: options.targetCommit }
      : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    modelSelection: options.modelSelection,
    runtimeMode: options.runtimeMode,
    interactionMode: options.interactionMode,
  };
}

export function buildFactoryResearchAdmitInput(options: {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly repository: FactoryRepository;
  readonly protocolId: FactoryResearchProtocolId;
  /** The finding the reviewer read, never one derived again at submit time. */
  readonly finding: Pick<FactoryResearchFinding, "revision">;
  readonly modelSelection: ModelSelection;
  readonly instructions: string;
  readonly runtimeMode: FactoryResearchImplementationAdmitInput["runtimeMode"];
  readonly interactionMode: FactoryResearchImplementationAdmitInput["interactionMode"];
  /** Only after the reviewer confirmed a new attempt for a deleted implementation thread. */
  readonly restartDeleted: boolean;
}): FactoryResearchImplementationAdmitInput {
  const instructions = normalizeFactoryFeedText(options.instructions);
  return {
    commandId: options.commandId,
    projectId: options.projectId,
    expectedRepositoryKey: options.repository.canonicalKey,
    protocolId: options.protocolId,
    expectedFindingRevision: options.finding.revision,
    ...(instructions !== undefined ? { instructions } : {}),
    modelSelection: options.modelSelection,
    runtimeMode: options.runtimeMode,
    interactionMode: options.interactionMode,
    ...(options.restartDeleted ? { restartDeleted: true } : {}),
  };
}

export type FactoryResearchFailureKind =
  | "permission"
  | "repository"
  | "changed"
  | "budget"
  | "other";

export interface FactoryResearchFailure {
  readonly kind: FactoryResearchFailureKind;
  readonly title: string;
  readonly message: string;
  readonly reason: FactoryResearchError["reason"] | null;
}

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isFactoryResearchError = Schema.is(FactoryResearchError);

const GENERIC_FAILURE_MESSAGE = "The environment request failed.";

export function describeFactoryResearchFailure(
  error: unknown,
  fallbackMessage?: string,
): FactoryResearchFailure {
  if (isAuthorizationError(error)) {
    return {
      kind: "permission",
      title: "Permission required",
      message: error.message.trim() || "This connection lacks permission for research runs.",
      reason: null,
    };
  }
  if (isFactoryResearchError(error)) {
    const { reason, message } = error;
    switch (reason) {
      case "protocol-changed":
        return { kind: "changed", title: "Protocol changed", message, reason };
      case "finding-changed":
        return { kind: "changed", title: "Finding changed", message, reason };
      case "missing-project":
      case "missing-repository":
      case "unsupported-provider":
      case "repository-changed":
        return { kind: "repository", title: "Repository unavailable", message, reason };
      case "protocol-expired":
      case "budget-exhausted":
        return { kind: "budget", title: "Budget unavailable", message, reason };
      case "invalid-base-ref":
      case "evaluator-missing":
        return { kind: "other", title: "Protocol rejected", message, reason };
      case "missing-protocol":
        return { kind: "other", title: "Protocol unavailable", message, reason };
      case "verify-requires-user":
      case "verify-target-missing":
      case "verification-not-independent":
        return { kind: "other", title: "Verification refused", message, reason };
      case "finding-not-supported":
        return { kind: "other", title: "Finding not supported", message, reason };
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

/**
 * The finding the reviewer pins when admitting: complete and inert, so what is approved is exactly
 * what the server will compare and freeze into the implementation's first message.
 */
export function factoryFindingReviewJson(
  protocol: FactoryResearchProtocol,
  finding: FactoryResearchFinding,
): string {
  return JSON.stringify(
    {
      protocol: {
        id: protocol.id,
        revision: protocol.revision,
        baseCommit: protocol.baseCommit,
        hypothesis: protocol.hypothesis,
        runCommand: protocol.runCommand,
        evaluators: protocol.evaluators,
        metric: protocol.metric,
        budget: protocol.budget,
      },
      finding,
    },
    null,
    2,
  );
}
