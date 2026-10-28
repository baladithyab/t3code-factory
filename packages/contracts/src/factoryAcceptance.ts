import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { FactoryOriginKey } from "./factoryClaims.ts";

const FACTORY_ACCEPTANCE_EVIDENCE_MAX_REFS = 32;

/**
 * A human's decision that one exact commit of a claimed task's worktree is good. It is pinned to
 * `headSha`: when the head moves the record stays as history but no longer describes the work.
 * `acceptedBy` is provenance only; the claim-holding environment owns the record and it is never
 * transferred.
 */
export const FactoryAcceptance = Schema.Struct({
  id: Schema.String,
  originKey: FactoryOriginKey,
  threadId: ThreadId,
  projectId: ProjectId,
  headSha: Schema.String,
  baseRef: Schema.String,
  baseSha: Schema.String,
  acceptedAt: IsoDateTime,
  acceptedBy: EnvironmentId,
  evidenceRefs: Schema.Array(Schema.String),
});
export type FactoryAcceptance = typeof FactoryAcceptance.Type;

/**
 * `expectedHeadSha` is only what the reviewer saw; the server observes the worktree head itself
 * and refuses when they differ, so the record can never pin a commit nobody reviewed.
 * `supersede` retires this thread's live acceptance after the head moved; without it a second
 * accept is refused so a stale record is never silently replaced.
 */
export const FactoryAcceptCommitInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  expectedHeadSha: TrimmedNonEmptyString,
  evidenceRefs: Schema.Array(TrimmedNonEmptyString).check(
    Schema.isMaxLength(FACTORY_ACCEPTANCE_EVIDENCE_MAX_REFS),
  ),
  supersede: Schema.optional(Schema.Boolean),
});
export type FactoryAcceptCommitInput = typeof FactoryAcceptCommitInput.Type;

export const FactoryAcceptanceReadInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
});
export type FactoryAcceptanceReadInput = typeof FactoryAcceptanceReadInput.Type;

export const FactoryAcceptanceReadResult = Schema.Struct({
  acceptance: Schema.NullOr(FactoryAcceptance),
  // Null when the worktree cannot be inspected; `current` is then false.
  liveHeadSha: Schema.NullOr(Schema.String),
  // Derived on every read, never stored: acceptance is current only while the head still matches.
  current: Schema.Boolean,
});
export type FactoryAcceptanceReadResult = typeof FactoryAcceptanceReadResult.Type;

export class FactoryAcceptanceError extends Schema.TaggedError<FactoryAcceptanceError>()(
  "FactoryAcceptanceError",
  {
    reason: Schema.Literals([
      "unknown-thread",
      "not-a-factory-task",
      "worktree-unavailable",
      "head-moved",
      "already-accepted",
      "persistence-failure",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unknown-thread":
        return "This thread does not exist in the selected project.";
      case "not-a-factory-task":
        return "This thread is not a claimed Factory task, so it has nothing to accept.";
      case "worktree-unavailable":
        return "The task's worktree is no longer available, so its commit cannot be read.";
      case "head-moved":
        return "The worktree head moved since you reviewed it. Review the current commit before accepting.";
      case "already-accepted":
        return "A commit is already accepted for this task. Acceptance is write-once.";
      case "persistence-failure":
        return "The environment could not read or save the acceptance.";
    }
  }
}
