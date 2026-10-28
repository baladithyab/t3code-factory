import {
  EnvironmentId,
  FactoryKnowledgeError,
  ProjectId,
  ThreadId,
  type FactoryKnowledgeArtifact,
  type FactoryKnowledgeAcceptance,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_KNOWLEDGE_DRAFT,
  factoryKnowledgeArtifactIssueMessage,
  factoryKnowledgeArtifactState,
  factoryKnowledgeFailureMessage,
  isFactoryKnowledgeDeliverablePath,
  validateFactoryKnowledgeDraft,
} from "./factoryKnowledge.logic";

describe("knowledge brief validation", () => {
  const draft = { ...EMPTY_KNOWLEDGE_DRAFT, title: "Compare storage options" };

  it("accepts the default deliverable and bounded pasted input", () => {
    expect(
      validateFactoryKnowledgeDraft({
        ...draft,
        title: "a".repeat(200),
        question: "q".repeat(8_000),
        acceptanceCriteria: "c".repeat(4_000),
        inputs: Array.from({ length: 8 }, () => ({
          label: "l".repeat(120),
          content: "x".repeat(64_000),
        })),
      }),
    ).toBeNull();
  });

  it.each([
    { title: " " },
    { title: "x".repeat(201) },
    { question: "x".repeat(8_001) },
    { acceptanceCriteria: "x".repeat(4_001) },
    { inputs: [{ label: " ", content: "" }] },
    { inputs: [{ label: "x".repeat(121), content: "" }] },
    { inputs: [{ label: "Input", content: "x".repeat(64_001) }] },
    { inputs: Array.from({ length: 9 }, () => ({ label: "Input", content: "" })) },
  ])("rejects invalid or oversized brief fields: %o", (fields) => {
    expect(validateFactoryKnowledgeDraft({ ...draft, ...fields })).not.toBeNull();
  });

  it.each([
    "",
    "../x",
    "a/../x",
    "/abs",
    "C:/abs",
    "C:x",
    "\\\\host\\share",
    ".git/x",
    "a/.git/x",
    ".GIT/x",
    "a\\..\\x",
    "./x",
    "a//x",
    "x/",
    "x\0",
  ])("rejects an unsafe or non-normalized path: %s", (path) => {
    expect(isFactoryKnowledgeDeliverablePath(path)).toBe(false);
    expect(validateFactoryKnowledgeDraft({ ...draft, deliverablePath: path })).not.toBeNull();
  });

  it.each([
    "DELIVERABLE.md",
    "notes/result.txt",
    "notes\\result.txt",
    ".github/report.md",
    "v1..2.md",
  ])("accepts a relative file path: %s", (path) => {
    expect(isFactoryKnowledgeDeliverablePath(path)).toBe(true);
  });
});

describe("knowledge failures", () => {
  it.each([
    ["unknown-brief", "brief is no longer available"],
    ["revision-mismatch", "revision changed"],
    ["already-started", "already has a task"],
    ["unknown-task", "no task available"],
    ["folder-unavailable", "folder is unavailable"],
    ["artifact-missing", "No artifact"],
    ["artifact-changed", "changed while you were reviewing"],
    ["already-accepted", "already accepted"],
    ["invalid-path", "relative file path"],
    ["persistence-failure", "could not save"],
  ] as const)("explains %s", (reason, message) => {
    expect(factoryKnowledgeFailureMessage(new FactoryKnowledgeError({ reason }))).toContain(
      message,
    );
  });

  it("preserves non-domain request failures", () => {
    expect(factoryKnowledgeFailureMessage(new Error("Disconnected"))).toBe("Disconnected");
    expect(factoryKnowledgeFailureMessage(null, "Read access denied")).toBe("Read access denied");
  });
});

describe("knowledge artifact state", () => {
  const artifact: FactoryKnowledgeArtifact = {
    path: "DELIVERABLE.md",
    sha256: "a".repeat(64),
    bytes: 4,
    preview: "text",
    observedAt: "2026-10-27T12:00:00.000Z",
  };
  const acceptance: FactoryKnowledgeAcceptance = {
    id: "acceptance:one",
    briefId: "brief:one",
    projectId: ProjectId.make("project:one"),
    threadId: ThreadId.make("thread:one"),
    artifactPath: artifact.path,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    acceptedAt: artifact.observedAt,
    acceptedBy: EnvironmentId.make("environment:one"),
  };

  it("distinguishes no acceptance from an unavailable observation", () => {
    expect(factoryKnowledgeArtifactState(null)).toBe("unverifiable");
    expect(
      factoryKnowledgeArtifactState({
        artifact: null,
        artifactIssue: null,
        acceptance: null,
        current: false,
      }),
    ).toBe("none");
    expect(
      factoryKnowledgeArtifactState({
        artifact,
        artifactIssue: null,
        acceptance: null,
        current: false,
      }),
    ).toBe("none");
  });

  it("uses the server's current flag for an observed accepted artifact", () => {
    expect(
      factoryKnowledgeArtifactState({ artifact, artifactIssue: null, acceptance, current: true }),
    ).toBe("current");
    expect(
      factoryKnowledgeArtifactState({
        artifact: { ...artifact, sha256: "b".repeat(64) },
        artifactIssue: null,
        acceptance,
        current: false,
      }),
    ).toBe("changed");
  });

  it("does not call a missing accepted file current or changed", () => {
    expect(
      factoryKnowledgeArtifactState({
        artifact: null,
        artifactIssue: "missing",
        acceptance,
        current: false,
      }),
    ).toBe("unverifiable");
  });

  it.each(["too-large", "unreadable"] as const)(
    "cannot verify an accepted artifact that is %s",
    (artifactIssue) => {
      expect(
        factoryKnowledgeArtifactState({
          artifact: null,
          artifactIssue,
          acceptance,
          current: false,
        }),
      ).toBe("unverifiable");
    },
  );

  it.each(["missing", "too-large", "unreadable"] as const)(
    "keeps an unaccepted artifact that is %s unaccepted",
    (artifactIssue) => {
      expect(
        factoryKnowledgeArtifactState({
          artifact: null,
          artifactIssue,
          acceptance: null,
          current: false,
        }),
      ).toBe("none");
    },
  );
});

describe("knowledge artifact issues", () => {
  it.each([
    ["missing", "No artifact yet at notes/result.md"],
    ["too-large", "The artifact is larger than 64 MiB and cannot be read or accepted."],
    ["unreadable", "The artifact exists but cannot be read."],
    [null, null],
  ] as const)("explains %s", (issue, message) => {
    expect(factoryKnowledgeArtifactIssueMessage(issue, "notes/result.md")).toBe(message);
  });
});
