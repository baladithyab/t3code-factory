import {
  FACTORY_KNOWLEDGE_ARTIFACT_MAX_BYTES,
  FACTORY_KNOWLEDGE_CRITERIA_MAX_CHARS,
  FACTORY_KNOWLEDGE_DEFAULT_DELIVERABLE_PATH,
  FACTORY_KNOWLEDGE_INPUT_CONTENT_MAX_CHARS,
  FACTORY_KNOWLEDGE_INPUT_LABEL_MAX_CHARS,
  FACTORY_KNOWLEDGE_INSTRUCTIONS_MAX_CHARS,
  FACTORY_KNOWLEDGE_MAX_INPUTS,
  FACTORY_KNOWLEDGE_QUESTION_MAX_CHARS,
  FACTORY_KNOWLEDGE_TITLE_MAX_CHARS,
  FactoryKnowledgeError,
  type FactoryKnowledgeBriefCreateInput,
  type FactoryKnowledgeTaskReadResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { describeFactoryFailure } from "./factoryIssues.logic";

export const KNOWLEDGE_LIMITS = {
  title: FACTORY_KNOWLEDGE_TITLE_MAX_CHARS,
  question: FACTORY_KNOWLEDGE_QUESTION_MAX_CHARS,
  acceptanceCriteria: FACTORY_KNOWLEDGE_CRITERIA_MAX_CHARS,
  inputLabel: FACTORY_KNOWLEDGE_INPUT_LABEL_MAX_CHARS,
  inputContent: FACTORY_KNOWLEDGE_INPUT_CONTENT_MAX_CHARS,
  inputs: FACTORY_KNOWLEDGE_MAX_INPUTS,
  instructions: FACTORY_KNOWLEDGE_INSTRUCTIONS_MAX_CHARS,
} as const;

const FAILURE_MESSAGES: Record<FactoryKnowledgeError["reason"], string> = {
  "unknown-brief": "This brief is no longer available. Refresh the brief list.",
  "revision-mismatch": "The brief revision changed. Close this dialog, refresh and review again.",
  "already-started": "This brief already has a task. Refresh to open its thread.",
  "unknown-task": "This brief has no task available. Refresh the brief list.",
  "folder-unavailable":
    "The task folder is unavailable. Starting a knowledge task needs a server data directory outside any git repository; an existing folder must be restored before accepting.",
  "artifact-missing": "No artifact was found. Open the thread and refresh when it is ready.",
  "artifact-changed": "The artifact changed while you were reviewing. Refresh and review it again.",
  "already-accepted": "An artifact is already accepted. Refresh and use Re-accept if it changed.",
  "invalid-path": "Use a relative file path without parent traversal or a .git directory.",
  "persistence-failure": "The environment could not save the change. Refresh before trying again.",
};

const isKnowledgeError = Schema.is(FactoryKnowledgeError);

export function factoryKnowledgeFailureMessage(error: unknown, fallbackMessage?: string): string {
  return isKnowledgeError(error)
    ? FAILURE_MESSAGES[error.reason]
    : describeFactoryFailure(error, fallbackMessage).message;
}

export type FactoryKnowledgeArtifactState = "none" | "current" | "changed" | "unverifiable";

export function factoryKnowledgeArtifactIssueMessage(
  issue: FactoryKnowledgeTaskReadResult["artifactIssue"],
  path: string,
): string | null {
  switch (issue) {
    case "missing":
      return `No artifact yet at ${path}`;
    case "too-large":
      return `The artifact is larger than ${FACTORY_KNOWLEDGE_ARTIFACT_MAX_BYTES / (1024 * 1024)} MiB and cannot be read or accepted.`;
    case "unreadable":
      return "The artifact exists but cannot be read.";
    case null:
      return null;
  }
}

export function factoryKnowledgeArtifactState(
  result: Pick<
    FactoryKnowledgeTaskReadResult,
    "artifact" | "artifactIssue" | "acceptance" | "current"
  > | null,
): FactoryKnowledgeArtifactState {
  if (result === null) return "unverifiable";
  if (result.acceptance === null) return "none";
  if (result.artifactIssue !== null || result.artifact === null) return "unverifiable";
  return result.current ? "current" : "changed";
}

export type FactoryKnowledgeDraft = Pick<
  FactoryKnowledgeBriefCreateInput,
  "title" | "question" | "inputs" | "acceptanceCriteria"
> & { readonly deliverablePath: string };

export const EMPTY_KNOWLEDGE_DRAFT: FactoryKnowledgeDraft = {
  title: "",
  question: "",
  deliverablePath: FACTORY_KNOWLEDGE_DEFAULT_DELIVERABLE_PATH,
  inputs: [],
  acceptanceCriteria: "",
};

export function isFactoryKnowledgeDeliverablePath(value: string): boolean {
  const path = value.trim().replaceAll("\\", "/");
  const parts = path.split("/");
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !/^[a-z]:/i.test(path) &&
    !path.includes("\0") &&
    parts.every(
      (part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git",
    )
  );
}

export function validateFactoryKnowledgeDraft(draft: FactoryKnowledgeDraft): string | null {
  if (draft.title.trim().length === 0) return "Enter a brief title.";
  if (draft.title.length > KNOWLEDGE_LIMITS.title) return "Keep the title to 200 characters.";
  if (draft.question.length > KNOWLEDGE_LIMITS.question)
    return "Keep the question to 8,000 characters.";
  if (draft.acceptanceCriteria.length > KNOWLEDGE_LIMITS.acceptanceCriteria) {
    return "Keep acceptance criteria to 4,000 characters.";
  }
  if (!isFactoryKnowledgeDeliverablePath(draft.deliverablePath)) {
    return FAILURE_MESSAGES["invalid-path"];
  }
  if (draft.inputs.length > KNOWLEDGE_LIMITS.inputs) return "Use no more than 8 inputs.";
  for (const [index, input] of draft.inputs.entries()) {
    if (input.label.trim().length === 0) return `Enter a label for input ${index + 1}.`;
    if (input.label.length > KNOWLEDGE_LIMITS.inputLabel) {
      return `Keep input ${index + 1}'s label to 120 characters.`;
    }
    if (input.content.length > KNOWLEDGE_LIMITS.inputContent) {
      return `Keep input ${index + 1}'s content to 64,000 characters.`;
    }
  }
  return null;
}
