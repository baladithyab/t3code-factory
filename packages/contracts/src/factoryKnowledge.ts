import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { FactoryIssueTask } from "./factory.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2CreationSource } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const FACTORY_KNOWLEDGE_TITLE_MAX_CHARS = 200;
export const FACTORY_KNOWLEDGE_QUESTION_MAX_CHARS = 8_000;
export const FACTORY_KNOWLEDGE_CRITERIA_MAX_CHARS = 4_000;
export const FACTORY_KNOWLEDGE_INPUT_LABEL_MAX_CHARS = 120;
export const FACTORY_KNOWLEDGE_INPUT_CONTENT_MAX_CHARS = 64_000;
export const FACTORY_KNOWLEDGE_MAX_INPUTS = 8;
export const FACTORY_KNOWLEDGE_INSTRUCTIONS_MAX_CHARS = 4_000;
export const FACTORY_KNOWLEDGE_DEFAULT_DELIVERABLE_PATH = "DELIVERABLE.md";
/** Artifact bytes returned inline for review; larger files keep only their digest and size. */
export const FACTORY_KNOWLEDGE_ARTIFACT_PREVIEW_MAX_BYTES = 262_144;
/** Largest deliverable the server will hash; a bigger file is reported as `too-large`, not read. */
export const FACTORY_KNOWLEDGE_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

export const FactoryKnowledgeInput = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(FACTORY_KNOWLEDGE_INPUT_LABEL_MAX_CHARS)),
  content: Schema.String.check(Schema.isMaxLength(FACTORY_KNOWLEDGE_INPUT_CONTENT_MAX_CHARS)),
});
export type FactoryKnowledgeInput = typeof FactoryKnowledgeInput.Type;

const BriefTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FACTORY_KNOWLEDGE_TITLE_MAX_CHARS),
);
const BriefQuestion = Schema.String.check(Schema.isMaxLength(FACTORY_KNOWLEDGE_QUESTION_MAX_CHARS));
const BriefCriteria = Schema.String.check(Schema.isMaxLength(FACTORY_KNOWLEDGE_CRITERIA_MAX_CHARS));
const BriefInputs = Schema.Array(FactoryKnowledgeInput).check(
  Schema.isMaxLength(FACTORY_KNOWLEDGE_MAX_INPUTS),
);

/**
 * A human-authored, immutable statement of a bounded knowledge deliverable. Editing mints a new
 * brief that names the old one in `supersedes`; a started task keeps the revision it was admitted
 * against. `revision` is computed by the server over the task-defining text only.
 */
export const FactoryKnowledgeBrief = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  title: BriefTitle,
  question: BriefQuestion,
  // Relative to the task's working folder. The server validates it; it is never a host path.
  deliverablePath: TrimmedNonEmptyString,
  inputs: BriefInputs,
  acceptanceCriteria: BriefCriteria,
  revision: Schema.String,
  createdAt: IsoDateTime,
  createdBy: EnvironmentId,
  supersededBy: Schema.NullOr(Schema.String),
});
export type FactoryKnowledgeBrief = typeof FactoryKnowledgeBrief.Type;

export const FactoryKnowledgeBriefCreateInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  title: BriefTitle,
  question: BriefQuestion,
  deliverablePath: Schema.optional(TrimmedNonEmptyString),
  inputs: BriefInputs,
  acceptanceCriteria: BriefCriteria,
  supersedes: Schema.optional(Schema.NullOr(Schema.String)),
});
export type FactoryKnowledgeBriefCreateInput = typeof FactoryKnowledgeBriefCreateInput.Type;

export const FactoryKnowledgeTask = Schema.Struct({
  briefId: Schema.String,
  threadId: ThreadId,
  // The issue task vocabulary: the same launch/thread states mean the same thing here.
  status: FactoryIssueTask.fields.status,
  // The task's working folder while its thread is live; null once the thread is deleted.
  folderPath: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  creationSource: OrchestrationV2CreationSource,
});
export type FactoryKnowledgeTask = typeof FactoryKnowledgeTask.Type;

export const FactoryKnowledgeBriefListInput = Schema.Struct({ projectId: ProjectId });
export type FactoryKnowledgeBriefListInput = typeof FactoryKnowledgeBriefListInput.Type;
export const FactoryKnowledgeBriefListResult = Schema.Struct({
  briefs: Schema.Array(FactoryKnowledgeBrief),
  tasks: Schema.Array(FactoryKnowledgeTask),
  fetchedAt: IsoDateTime,
});
export type FactoryKnowledgeBriefListResult = typeof FactoryKnowledgeBriefListResult.Type;

export const FactoryKnowledgeStartInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  briefId: Schema.String,
  // The revision the caller reviewed. A new task requires it to match the stored brief; an
  // existing task resumes the snapshot it was admitted with and ignores this value.
  expectedRevision: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  instructions: Schema.optional(
    Schema.String.check(Schema.isMaxLength(FACTORY_KNOWLEDGE_INSTRUCTIONS_MAX_CHARS)),
  ),
  restartDeleted: Schema.optional(Schema.Boolean),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
});
export type FactoryKnowledgeStartInput = typeof FactoryKnowledgeStartInput.Type;
export const FactoryKnowledgeStartResult = Schema.Struct({
  task: FactoryKnowledgeTask,
  resumed: Schema.Boolean,
});
export type FactoryKnowledgeStartResult = typeof FactoryKnowledgeStartResult.Type;

/**
 * What the server observed at `path` in the task's folder. The digest proves which bytes were
 * read, never that they are true.
 */
export const FactoryKnowledgeArtifact = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Int,
  // A UTF-8 prefix up to FACTORY_KNOWLEDGE_ARTIFACT_PREVIEW_MAX_BYTES; null when not text.
  preview: Schema.NullOr(Schema.String),
  observedAt: IsoDateTime,
});
export type FactoryKnowledgeArtifact = typeof FactoryKnowledgeArtifact.Type;

/**
 * A human's decision that exactly these artifact bytes answer the brief. It is pinned to
 * `sha256`: when the file changes the record stays as history but no longer describes it.
 */
export const FactoryKnowledgeAcceptance = Schema.Struct({
  id: Schema.String,
  briefId: Schema.String,
  threadId: ThreadId,
  projectId: ProjectId,
  artifactPath: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Int,
  acceptedAt: IsoDateTime,
  acceptedBy: EnvironmentId,
});
export type FactoryKnowledgeAcceptance = typeof FactoryKnowledgeAcceptance.Type;

export const FactoryKnowledgeTaskReadInput = Schema.Struct({
  projectId: ProjectId,
  briefId: Schema.String,
});
export type FactoryKnowledgeTaskReadInput = typeof FactoryKnowledgeTaskReadInput.Type;
export const FactoryKnowledgeTaskReadResult = Schema.Struct({
  brief: FactoryKnowledgeBrief,
  task: Schema.NullOr(FactoryKnowledgeTask),
  artifact: Schema.NullOr(FactoryKnowledgeArtifact),
  // Why `artifact` is null while the task still has a live folder; null otherwise.
  artifactIssue: Schema.NullOr(Schema.Literals(["missing", "too-large", "unreadable"])),
  acceptance: Schema.NullOr(FactoryKnowledgeAcceptance),
  // Derived on every read, never stored: acceptance is current only while the digest matches.
  current: Schema.Boolean,
});
export type FactoryKnowledgeTaskReadResult = typeof FactoryKnowledgeTaskReadResult.Type;

/**
 * `expectedSha256` is only what the reviewer saw; the server hashes the file itself and refuses
 * when they differ, so the record can never pin bytes nobody reviewed. `supersede` retires the
 * brief's live acceptance after the artifact changed; without it a second accept is refused.
 */
export const FactoryKnowledgeAcceptInput = Schema.Struct({
  projectId: ProjectId,
  briefId: Schema.String,
  expectedSha256: Schema.String,
  supersede: Schema.optional(Schema.Boolean),
});
export type FactoryKnowledgeAcceptInput = typeof FactoryKnowledgeAcceptInput.Type;

export class FactoryKnowledgeError extends Schema.TaggedError<FactoryKnowledgeError>()(
  "FactoryKnowledgeError",
  {
    reason: Schema.Literals([
      "unknown-brief",
      "revision-mismatch",
      "already-started",
      "unknown-task",
      "folder-unavailable",
      "artifact-missing",
      "artifact-changed",
      "already-accepted",
      "invalid-path",
      "persistence-failure",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unknown-brief":
        return "This brief does not exist in the selected project, or it was already replaced by a newer one.";
      case "revision-mismatch":
        return "The brief no longer matches the revision you reviewed. Refresh and review the current brief before starting.";
      case "already-started":
        return "A task is already running for this brief. Open it instead of starting another.";
      case "unknown-task":
        return "No task has been started for this brief.";
      case "folder-unavailable":
        return "The task's working folder is not available on this environment. Starting a knowledge task needs a server data directory outside any git repository.";
      case "artifact-missing":
        return "The deliverable file does not exist in the task's folder yet.";
      case "artifact-changed":
        return "The deliverable changed since you reviewed it. Review the current file before accepting.";
      case "already-accepted":
        return "An artifact is already accepted for this brief. Re-accept the current file to replace it.";
      case "invalid-path":
        return "The deliverable path must be a relative path inside the task folder, without '..' or a .git segment.";
      case "persistence-failure":
        return "The environment could not read or save the knowledge brief.";
    }
  }
}
