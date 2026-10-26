import * as Schema from "effect/Schema";
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { FactoryIssueTask, FactoryRepository } from "./factory.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2CreationSource } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const FactoryResearchProtocolId = Schema.String.pipe(
  Schema.brand("FactoryResearchProtocolId"),
);
export type FactoryResearchProtocolId = typeof FactoryResearchProtocolId.Type;

export const FACTORY_RESEARCH_HYPOTHESIS_MAX_CHARS = 2048;
export const FACTORY_RESEARCH_RUN_COMMAND_MAX_CHARS = 1024;
export const FACTORY_RESEARCH_INSTRUCTIONS_MAX_CHARS = 4096;
export const FACTORY_RESEARCH_EVALUATOR_MAX_PATHS = 16;
const FACTORY_RESEARCH_CITATION_MAX_COUNT = 16;
/** Cited artifact bytes retained inline up to this size; larger files keep only their digest. */
export const FACTORY_RESEARCH_ARTIFACT_INLINE_MAX_BYTES = 256 * 1024;
/**
 * A cited line longer than this is an invalid citation. It is never stored or truncated, so
 * evidence stays bounded even when the artifact itself keeps only its digest.
 */
export const FACTORY_RESEARCH_CITED_LINE_MAX_BYTES = 4096;

/**
 * The run only ever reports where a number is; the server reads the cited line and extracts
 * the value after `linePrefix`, so no metric value is agent-supplied.
 */
export const FactoryResearchMetricSpec = Schema.Struct({
  name: TrimmedNonEmptyString,
  linePrefix: TrimmedNonEmptyString,
  direction: Schema.Literals(["lower", "higher"]),
  // Null means the decision rule was not declared; the finding then stays unknown.
  minimumEffect: Schema.NullOr(Schema.Number),
});
export type FactoryResearchMetricSpec = typeof FactoryResearchMetricSpec.Type;

/** Resolved by the server at seal time from `baseCommit`; the agent never supplies an OID. */
export const FactoryResearchEvaluator = Schema.Struct({
  path: TrimmedNonEmptyString,
  blobOid: TrimmedNonEmptyString,
});
export type FactoryResearchEvaluator = typeof FactoryResearchEvaluator.Type;

export const FactoryResearchBudget = Schema.Struct({
  maxRuns: PositiveInt,
  maxRunMinutes: PositiveInt,
  expiresAt: IsoDateTime,
});
export type FactoryResearchBudget = typeof FactoryResearchBudget.Type;

/**
 * Sealed once inside the launch intents that cite it. A change is a new protocol. `revision` is
 * an opaque SHA-256 over the versioned protocol tuple; compare it, never parse it.
 */
export const FactoryResearchProtocol = Schema.Struct({
  id: FactoryResearchProtocolId,
  projectId: ProjectId,
  repository: FactoryRepository,
  baseCommit: TrimmedNonEmptyString,
  hypothesis: Schema.String,
  runCommand: Schema.String,
  evaluators: Schema.Array(FactoryResearchEvaluator),
  metric: FactoryResearchMetricSpec,
  budget: FactoryResearchBudget,
  revision: TrimmedNonEmptyString,
  sealedAt: IsoDateTime,
});
export type FactoryResearchProtocol = typeof FactoryResearchProtocol.Type;

export const FactoryResearchRunRole = Schema.Literals(["explore", "verify", "implementation"]);
export type FactoryResearchRunRole = typeof FactoryResearchRunRole.Type;

export const FactoryResearchArtifact = Schema.Struct({
  path: TrimmedNonEmptyString,
  line: PositiveInt,
  sha256: TrimmedNonEmptyString,
  bytes: NonNegativeInt,
  retention: Schema.Literals(["inline", "digest-only"]),
  // The exact cited line as read by the server, or null when the line did not exist or exceeded
  // FACTORY_RESEARCH_CITED_LINE_MAX_BYTES.
  lineText: Schema.NullOr(Schema.String),
});
export type FactoryResearchArtifact = typeof FactoryResearchArtifact.Type;

/** Derived on every read from write-once evidence; never stored. */
export const FactoryResearchDisposition = Schema.Literals([
  "acceptable",
  "evaluator-changed",
  "not-descendant",
  "citation-invalid",
  "over-budget",
  "unknown",
]);
export type FactoryResearchDisposition = typeof FactoryResearchDisposition.Type;

export const FactoryResearchObservation = Schema.Struct({
  threadId: ThreadId,
  role: FactoryResearchRunRole,
  commit: TrimmedNonEmptyString,
  recordedAt: IsoDateTime,
  // Null when the ancestry check could not run; it never counts as a descendant.
  ancestorOfBase: Schema.NullOr(Schema.Boolean),
  evaluators: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString,
      blobOid: Schema.NullOr(TrimmedNonEmptyString),
      matchesSealed: Schema.Boolean,
    }),
  ),
  artifacts: Schema.Array(FactoryResearchArtifact),
  metricValue: Schema.NullOr(Schema.Number),
  missing: Schema.Array(Schema.String),
  runCount: NonNegativeInt,
  // Derived on read from the run lifecycle: until now while the thread runs, else until its
  // latest run completed. It never drops below the time at which the evidence was recorded.
  elapsedMinutes: NonNegativeInt,
  disposition: FactoryResearchDisposition,
});
export type FactoryResearchObservation = typeof FactoryResearchObservation.Type;

export const FactoryResearchRun = Schema.Struct({
  threadId: ThreadId,
  role: FactoryResearchRunRole,
  protocolId: FactoryResearchProtocolId,
  protocolRevision: TrimmedNonEmptyString,
  // Set when an explore run was launched through MCP by another thread; a verify run launched
  // by that thread or its descendants is not independent.
  launchedByThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  task: FactoryIssueTask,
  observation: Schema.NullOr(FactoryResearchObservation),
});
export type FactoryResearchRun = typeof FactoryResearchRun.Type;

export const FactoryResearchFindingReason = Schema.Literals([
  "rule-not-declared",
  "baseline-missing",
  "explore-missing",
  "verification-missing",
  "verification-not-independent",
  "run-not-acceptable",
  "effect-below-minimum",
  "protocol-expired",
]);
export type FactoryResearchFindingReason = typeof FactoryResearchFindingReason.Type;

/**
 * Derived on read. `supported` requires an acceptable observation at the base commit (the
 * measured baseline), an acceptable explore observation at a candidate commit, and an
 * acceptable web-launched verify observation at that same commit, with both candidate values
 * clearing `minimumEffect` in the sealed direction against the baseline. k=1; variance is
 * unmeasured and said so.
 */
export const FactoryResearchFinding = Schema.Struct({
  protocolId: FactoryResearchProtocolId,
  protocolRevision: TrimmedNonEmptyString,
  status: Schema.Literals(["supported", "unsupported", "unknown"]),
  reasons: Schema.Array(FactoryResearchFindingReason),
  selectedCommit: Schema.NullOr(TrimmedNonEmptyString),
  baselineValue: Schema.NullOr(Schema.Number),
  exploreValue: Schema.NullOr(Schema.Number),
  verifyValue: Schema.NullOr(Schema.Number),
  baselineThreadId: Schema.NullOr(ThreadId),
  exploreThreadId: Schema.NullOr(ThreadId),
  verifyThreadId: Schema.NullOr(ThreadId),
  // Opaque SHA-256 over the protocol revision, status, reasons, selected commit and each
  // selected observation's thread, role, commit, value and cited path, line and digest.
  revision: TrimmedNonEmptyString,
});
export type FactoryResearchFinding = typeof FactoryResearchFinding.Type;

export const FactoryResearchProtocolListInput = Schema.Struct({ projectId: ProjectId });
export type FactoryResearchProtocolListInput = typeof FactoryResearchProtocolListInput.Type;
export const FactoryResearchProtocolListResult = Schema.Struct({
  repository: FactoryRepository,
  protocols: Schema.Array(FactoryResearchProtocol),
  fetchedAt: IsoDateTime,
});
export type FactoryResearchProtocolListResult = typeof FactoryResearchProtocolListResult.Type;

export const FactoryResearchProtocolReadInput = Schema.Struct({
  projectId: ProjectId,
  protocolId: FactoryResearchProtocolId,
});
export type FactoryResearchProtocolReadInput = typeof FactoryResearchProtocolReadInput.Type;
export const FactoryResearchProtocolReadResult = Schema.Struct({
  repository: FactoryRepository,
  protocol: FactoryResearchProtocol,
  runs: Schema.Array(FactoryResearchRun),
  finding: FactoryResearchFinding,
  fetchedAt: IsoDateTime,
});
export type FactoryResearchProtocolReadResult = typeof FactoryResearchProtocolReadResult.Type;

export const FactoryResearchProtocolSealInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  expectedRepositoryKey: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  hypothesis: TrimmedNonEmptyString.check(
    Schema.isMaxLength(FACTORY_RESEARCH_HYPOTHESIS_MAX_CHARS),
  ),
  runCommand: TrimmedNonEmptyString.check(
    Schema.isMaxLength(FACTORY_RESEARCH_RUN_COMMAND_MAX_CHARS),
  ),
  evaluatorPaths: Schema.Array(TrimmedNonEmptyString).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(FACTORY_RESEARCH_EVALUATOR_MAX_PATHS),
  ),
  metric: FactoryResearchMetricSpec,
  budget: FactoryResearchBudget,
});
export type FactoryResearchProtocolSealInput = typeof FactoryResearchProtocolSealInput.Type;
export const FactoryResearchProtocolSealResult = Schema.Struct({
  repository: FactoryRepository,
  protocol: FactoryResearchProtocol,
});
export type FactoryResearchProtocolSealResult = typeof FactoryResearchProtocolSealResult.Type;

export const FactoryResearchRunLaunchInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  expectedRepositoryKey: TrimmedNonEmptyString,
  protocolId: FactoryResearchProtocolId,
  expectedProtocolRevision: FactoryResearchProtocol.fields.revision,
  role: Schema.Literals(["explore", "verify"]),
  // Verify runs pin to the candidate commit under test; explore runs start from the base.
  targetCommit: Schema.optional(TrimmedNonEmptyString),
  instructions: Schema.optional(
    Schema.String.check(Schema.isMaxLength(FACTORY_RESEARCH_INSTRUCTIONS_MAX_CHARS)),
  ),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  creationSource: Schema.optional(OrchestrationV2CreationSource),
});
export type FactoryResearchRunLaunchInput = typeof FactoryResearchRunLaunchInput.Type;
export const FactoryResearchRunLaunchResult = Schema.Struct({
  repository: FactoryRepository,
  protocolId: FactoryResearchProtocolId,
  role: FactoryResearchRunRole,
  projectId: ProjectId,
  threadId: ThreadId,
  task: FactoryIssueTask,
  resumed: Schema.Boolean,
});
export type FactoryResearchRunLaunchResult = typeof FactoryResearchRunLaunchResult.Type;

export const FactoryResearchCitation = Schema.Struct({
  path: TrimmedNonEmptyString,
  line: PositiveInt,
});
export type FactoryResearchCitation = typeof FactoryResearchCitation.Type;
/** Recorded only by the run's own thread; write-once per thread. */
export const FactoryResearchEvidenceRecordInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  commit: TrimmedNonEmptyString,
  citations: Schema.Array(FactoryResearchCitation).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(FACTORY_RESEARCH_CITATION_MAX_COUNT),
  ),
  missing: Schema.Array(Schema.String),
});
export type FactoryResearchEvidenceRecordInput = typeof FactoryResearchEvidenceRecordInput.Type;
export const FactoryResearchEvidenceRecordResult = Schema.Struct({
  observation: FactoryResearchObservation,
});
export type FactoryResearchEvidenceRecordResult = typeof FactoryResearchEvidenceRecordResult.Type;

export const FactoryResearchImplementationAdmitInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  expectedRepositoryKey: TrimmedNonEmptyString,
  protocolId: FactoryResearchProtocolId,
  // The finding revision the reviewer saw; the reserve transaction re-checks it.
  expectedFindingRevision: FactoryResearchFinding.fields.revision,
  instructions: Schema.optional(
    Schema.String.check(Schema.isMaxLength(FACTORY_RESEARCH_INSTRUCTIONS_MAX_CHARS)),
  ),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  restartDeleted: Schema.optional(Schema.Boolean),
});
export type FactoryResearchImplementationAdmitInput =
  typeof FactoryResearchImplementationAdmitInput.Type;
export const FactoryResearchImplementationAdmitResult = Schema.Struct({
  repository: FactoryRepository,
  protocolId: FactoryResearchProtocolId,
  projectId: ProjectId,
  threadId: ThreadId,
  task: FactoryIssueTask,
  resumed: Schema.Boolean,
});
export type FactoryResearchImplementationAdmitResult =
  typeof FactoryResearchImplementationAdmitResult.Type;

export class FactoryResearchError extends Schema.TaggedError<FactoryResearchError>()(
  "FactoryResearchError",
  {
    reason: Schema.Literals([
      "missing-project",
      "missing-repository",
      "unsupported-provider",
      "repository-changed",
      "invalid-base-ref",
      "evaluator-missing",
      "missing-protocol",
      "protocol-changed",
      "protocol-expired",
      "budget-exhausted",
      "verify-requires-user",
      "verify-target-missing",
      "verification-not-independent",
      "missing-run",
      "not-run-thread",
      "evidence-already-recorded",
      "worktree-unavailable",
      "citation-outside-worktree",
      "finding-changed",
      "finding-not-supported",
      "deleted-task",
      "launch-failure",
      "launch-authority",
      "provider-unavailable",
      "persistence-failure",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "missing-project":
        return "The selected project no longer exists.";
      case "missing-repository":
        return "The project has no usable repository remote.";
      case "unsupported-provider":
        return "The project's repository is not supported. Research runs require a GitHub remote.";
      case "repository-changed":
        return "The repository changed since this protocol was reviewed. Refresh before continuing.";
      case "invalid-base-ref":
        return "The base ref does not resolve to a local commit. Choose an existing branch, tag, or commit.";
      case "evaluator-missing":
        return "An evaluator path does not exist at the base commit. Commit the evaluator before sealing.";
      case "missing-protocol":
        return "This protocol no longer exists for the project.";
      case "protocol-changed":
        return "The protocol no longer matches the reviewed revision. Review the current protocol before launching.";
      case "protocol-expired":
        return "The protocol's budget window has expired. Seal a new protocol to continue.";
      case "budget-exhausted":
        return "The protocol's run budget is used up. Seal a new protocol to run more experiments.";
      case "verify-requires-user":
        return "Verification runs can only be launched by a person from the app, not by an agent.";
      case "verify-target-missing":
        return "A verification run needs the candidate commit of an acceptable explore observation.";
      case "verification-not-independent":
        return "This verification would be launched by the thread that produced the result. Launch it from the app.";
      case "missing-run":
        return "No research run is recorded for this thread.";
      case "not-run-thread":
        return "Only the run's own thread can record its evidence.";
      case "evidence-already-recorded":
        return "This run already recorded its evidence; evidence is write-once.";
      case "worktree-unavailable":
        return "The run's worktree is no longer available, so cited files cannot be read.";
      case "citation-outside-worktree":
        return "A cited path resolves outside the run's worktree.";
      case "finding-changed":
        return "The finding no longer matches the reviewed revision. Review the current finding before admitting work.";
      case "finding-not-supported":
        return "Only a supported finding can be promoted into implementation work.";
      case "deleted-task":
        return "The linked thread or its owning project was deleted. Confirm a new attempt to restart this work.";
      case "launch-authority":
        return "This reserved launch exceeds the caller's runtime authority. Resume it from an authorized client.";
      case "launch-failure":
        return "The launch was interrupted. Retry to resume the same reserved task.";
      case "provider-unavailable":
        return "The selected provider is unavailable or disabled for this project.";
      case "persistence-failure":
        return "The environment could not read or save the research records.";
    }
  }
}
