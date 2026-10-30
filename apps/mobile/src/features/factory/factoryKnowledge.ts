import {
  FACTORY_KNOWLEDGE_CRITERIA_MAX_CHARS,
  FACTORY_KNOWLEDGE_DEFAULT_DELIVERABLE_PATH,
  FACTORY_KNOWLEDGE_INPUT_CONTENT_MAX_CHARS,
  FACTORY_KNOWLEDGE_INPUT_LABEL_MAX_CHARS,
  FACTORY_KNOWLEDGE_INSTRUCTIONS_MAX_CHARS,
  FACTORY_KNOWLEDGE_MAX_INPUTS,
  FACTORY_KNOWLEDGE_QUESTION_MAX_CHARS,
  FACTORY_KNOWLEDGE_TITLE_MAX_CHARS,
  FactoryKnowledgeError,
  type FactoryKnowledgeAcceptance,
  type FactoryKnowledgeArtifact,
  type FactoryKnowledgeBrief,
  type FactoryKnowledgeBriefCreateInput,
  type FactoryKnowledgeTask,
  type FactoryKnowledgeTaskReadResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { describeFactoryFailure, type FactoryFailure } from "./factoryIssues";

export const FACTORY_KNOWLEDGE_LIMITS = {
  title: FACTORY_KNOWLEDGE_TITLE_MAX_CHARS,
  question: FACTORY_KNOWLEDGE_QUESTION_MAX_CHARS,
  criteria: FACTORY_KNOWLEDGE_CRITERIA_MAX_CHARS,
  inputLabel: FACTORY_KNOWLEDGE_INPUT_LABEL_MAX_CHARS,
  inputContent: FACTORY_KNOWLEDGE_INPUT_CONTENT_MAX_CHARS,
  inputs: FACTORY_KNOWLEDGE_MAX_INPUTS,
  instructions: FACTORY_KNOWLEDGE_INSTRUCTIONS_MAX_CHARS,
} as const;

export const FACTORY_KNOWLEDGE_NOTICE =
  "Knowledge tasks run in a private folder, not in this checkout. Accepting an artifact records which bytes you reviewed, not that they are correct.";

export interface FactoryKnowledgeInputDraft {
  readonly key?: string;
  readonly label: string;
  readonly content: string;
}

export interface FactoryKnowledgeBriefDraft {
  readonly title: string;
  readonly question: string;
  readonly deliverablePath: string;
  readonly inputs: ReadonlyArray<FactoryKnowledgeInputDraft>;
  readonly acceptanceCriteria: string;
}

export const EMPTY_FACTORY_KNOWLEDGE_DRAFT: FactoryKnowledgeBriefDraft = {
  title: "",
  question: "",
  deliverablePath: FACTORY_KNOWLEDGE_DEFAULT_DELIVERABLE_PATH,
  inputs: [],
  acceptanceCriteria: "",
};

/**
 * Mirrors the server's rule so a bad path is explained before submitting; the server still
 * decides. The artifact must stay inside the task folder and outside any `.git` directory.
 */
export function factoryKnowledgeDeliverablePathProblem(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed.length === 0) return "Enter a deliverable path.";
  if (/^[/\\]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    return "Use a path relative to the task folder, not an absolute path.";
  }
  const segments = trimmed.split(/[/\\]/);
  if (segments.includes("..")) return 'The deliverable path can\'t contain "..".';
  if (segments.some((segment) => segment === "" || segment === ".")) {
    return "Use a plain relative path such as notes/answer.md.";
  }
  if (segments[0]?.toLowerCase() === ".git") {
    return "The deliverable can't be written inside .git.";
  }
  return null;
}

/** The first problem that would make the server refuse the brief, or null when it can be sent. */
export function factoryKnowledgeDraftProblem(draft: FactoryKnowledgeBriefDraft): string | null {
  const limits = FACTORY_KNOWLEDGE_LIMITS;
  if (draft.title.trim().length === 0) return "Enter a title.";
  if (draft.title.trim().length > limits.title) {
    return `The title is longer than ${limits.title} characters.`;
  }
  if (draft.question.trim().length === 0) return "Enter the question the deliverable answers.";
  if (draft.question.length > limits.question) {
    return `The question is longer than ${limits.question} characters.`;
  }
  const pathProblem = factoryKnowledgeDeliverablePathProblem(draft.deliverablePath);
  if (pathProblem !== null) return pathProblem;
  if (draft.inputs.length > limits.inputs)
    return `A brief can have at most ${limits.inputs} inputs.`;
  for (const [index, input] of draft.inputs.entries()) {
    const label = input.label.trim();
    if (label.length === 0) return `Input ${index + 1} needs a label.`;
    if (label.length > limits.inputLabel) {
      return `Input ${index + 1} has a label longer than ${limits.inputLabel} characters.`;
    }
    if (input.content.length > limits.inputContent) {
      return `Input ${index + 1} is longer than ${limits.inputContent} characters.`;
    }
  }
  if (draft.acceptanceCriteria.length > limits.criteria) {
    return `The acceptance criteria are longer than ${limits.criteria} characters.`;
  }
  return null;
}

/**
 * The exact create payload without its command id. Retries of an unchanged draft reuse one
 * command id, so this is also the key that decides whether a press is a retry.
 */
export function factoryKnowledgeCreatePayload(
  draft: FactoryKnowledgeBriefDraft,
): Omit<FactoryKnowledgeBriefCreateInput, "commandId" | "projectId" | "supersedes"> {
  return {
    title: draft.title.trim(),
    question: draft.question,
    deliverablePath: draft.deliverablePath.trim(),
    inputs: draft.inputs.map((input) => ({ label: input.label.trim(), content: input.content })),
    acceptanceCriteria: draft.acceptanceCriteria,
  };
}

/** Newest first; a superseded brief stays listed so its task and acceptance remain reachable. */
export function sortFactoryKnowledgeBriefs(
  briefs: ReadonlyArray<FactoryKnowledgeBrief>,
): ReadonlyArray<FactoryKnowledgeBrief> {
  return [...briefs].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function factoryKnowledgeTaskFor(
  tasks: ReadonlyArray<FactoryKnowledgeTask>,
  briefId: string,
): FactoryKnowledgeTask | null {
  return tasks.find((task) => task.briefId === briefId) ?? null;
}

export type FactoryKnowledgeAction =
  | { readonly kind: "open"; readonly label: string; readonly task: FactoryKnowledgeTask }
  | { readonly kind: "start"; readonly label: string }
  | { readonly kind: "resume"; readonly label: string }
  | { readonly kind: "restart"; readonly label: string; readonly task: FactoryKnowledgeTask }
  | { readonly kind: "unavailable"; readonly label: string; readonly detail: string };

/**
 * One primary action per brief, with the issue inbox's semantics: a deleted thread needs an
 * explicit new attempt, and a superseded brief never starts new work but keeps its thread.
 */
export function factoryKnowledgeAction(
  brief: FactoryKnowledgeBrief,
  task: FactoryKnowledgeTask | null,
): FactoryKnowledgeAction {
  const supersededDetail = "A newer brief replaced this one. Start the newer brief instead.";
  if (task === null) {
    return brief.supersededBy === null
      ? { kind: "start", label: "Start task" }
      : { kind: "unavailable", label: "Superseded", detail: supersededDetail };
  }
  switch (task.status) {
    case "missing":
      return brief.supersededBy === null
        ? { kind: "restart", label: "Start new attempt", task }
        : {
            kind: "unavailable",
            label: "Thread deleted",
            detail: `The linked thread was deleted. ${supersededDetail}`,
          };
    case "launching":
      return { kind: "resume", label: "Resume launch" };
    default:
      return { kind: "open", label: "Open thread", task };
  }
}

/**
 * What the artifact area can honestly say. An artifact that cannot be read now is never shown
 * as "changed": nothing is known to differ, only that the bytes cannot be compared.
 */
export type FactoryKnowledgeArtifactView =
  | {
      readonly kind: "none";
      readonly artifact: FactoryKnowledgeArtifact | null;
      readonly unavailable: string | null;
    }
  | {
      readonly kind: "current";
      readonly acceptance: FactoryKnowledgeAcceptance;
      readonly artifact: FactoryKnowledgeArtifact;
    }
  | {
      readonly kind: "changed";
      readonly acceptance: FactoryKnowledgeAcceptance;
      readonly artifact: FactoryKnowledgeArtifact;
    }
  | {
      readonly kind: "unverifiable";
      readonly acceptance: FactoryKnowledgeAcceptance;
      readonly unavailable: string;
    };

function artifactUnavailableText(read: FactoryKnowledgeTaskReadResult): string {
  if (read.task === null) return "No task has started for this brief.";
  if (read.task.folderPath === null) {
    return "The task folder is no longer available, so the artifact can't be read.";
  }
  switch (read.artifactIssue) {
    case "too-large":
      return "The artifact is too large to read and accept.";
    case "unreadable":
      return "The artifact exists but can't be read.";
    default:
      return `No artifact yet at ${read.brief.deliverablePath}.`;
  }
}

export function factoryKnowledgeArtifactView(
  read: FactoryKnowledgeTaskReadResult,
): FactoryKnowledgeArtifactView {
  const { acceptance, artifact } = read;
  if (acceptance === null) {
    return {
      kind: "none",
      artifact,
      unavailable: artifact === null ? artifactUnavailableText(read) : null,
    };
  }
  if (artifact === null) {
    return { kind: "unverifiable", acceptance, unavailable: artifactUnavailableText(read) };
  }
  // `current` is the server's comparison; the digests are compared here only to never claim a
  // match the server did not report.
  return read.current && artifact.sha256 === acceptance.sha256
    ? { kind: "current", acceptance, artifact }
    : { kind: "changed", acceptance, artifact };
}

export function shortFactoryDigest(sha256: string): string {
  return sha256.slice(0, 7);
}

export function formatFactoryBytes(bytes: number): string {
  if (bytes < 1024) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const PREVIEW_MAX_CHARACTERS = 6_000;
// Control characters other than tab and newline, plus bidirectional overrides and isolates that
// can reorder surrounding text.
const UNSAFE_PREVIEW_TEXT = /(?![\t\n])[\p{Cc}‪-‮⁦-⁩]/gu;

/**
 * The server preview can be 256 KiB, far more than a phone should lay out in one text node. The
 * screen shows a bounded, plain-text prefix and says when the rest was left out.
 */
export function factoryKnowledgePreview(
  preview: string | null,
): { readonly text: string; readonly truncated: boolean } | null {
  if (preview === null) return null;
  const cleaned = preview.replace(/\r\n?/g, "\n").replace(UNSAFE_PREVIEW_TEXT, "");
  return cleaned.length > PREVIEW_MAX_CHARACTERS
    ? { text: cleaned.slice(0, PREVIEW_MAX_CHARACTERS), truncated: true }
    : { text: cleaned, truncated: false };
}

export function factoryKnowledgeStartKey(input: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly briefId: string;
  readonly expectedRevision: string;
  readonly restartDeleted: boolean;
  readonly previousThreadId: string | null;
  readonly modelSelection: unknown;
  readonly runtimeMode: string | null;
  readonly instructions: string;
}): string {
  return JSON.stringify([
    input.environmentId,
    input.projectId,
    input.briefId,
    input.expectedRevision,
    input.restartDeleted,
    input.previousThreadId,
    input.modelSelection,
    input.runtimeMode,
    input.instructions,
  ]);
}

const isFactoryKnowledgeError = Schema.is(FactoryKnowledgeError);

/** Maps a typed knowledge failure to text a person can act on. */
export function describeFactoryKnowledgeFailure(
  error: unknown,
  fallbackTitle: string,
): FactoryFailure {
  if (isFactoryKnowledgeError(error)) {
    switch (error.reason) {
      case "unknown-brief":
        return {
          kind: "changed",
          title: "Brief unavailable",
          detail: "This brief no longer exists in this project. Refresh the list.",
        };
      case "revision-mismatch":
        return {
          kind: "changed",
          title: "Brief changed",
          detail: "The brief changed since you reviewed it. Close this review and refresh.",
        };
      case "already-started":
        return {
          kind: "changed",
          title: "Already started",
          detail: "A task is already running for this brief. Refresh to open it.",
        };
      case "unknown-task":
        return {
          kind: "changed",
          title: "No task",
          detail: "No task has started for this brief. Refresh the list.",
        };
      case "folder-unavailable":
        return {
          kind: "repository",
          title: "Folder unavailable",
          detail: "The task folder is no longer available, so the artifact can't be read.",
        };
      case "artifact-missing":
        return {
          kind: "changed",
          title: "No artifact",
          detail: "There is no readable artifact to accept. Refresh to see why.",
        };
      case "artifact-changed":
        return {
          kind: "changed",
          title: "Artifact changed",
          detail: "The artifact changed while you were reviewing it. Refresh and review again.",
        };
      case "already-accepted":
        return {
          kind: "changed",
          title: "Already accepted",
          detail: "An artifact is already accepted for this brief. Refresh, then use Re-accept.",
        };
      case "invalid-path":
        return { kind: "error", title: "Invalid deliverable path", detail: error.message };
      default:
        return { kind: "error", title: fallbackTitle, detail: error.message };
    }
  }
  return describeFactoryFailure(error, fallbackTitle);
}
