import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  FactoryKnowledgeError,
  ProjectId,
  ThreadId,
  type FactoryKnowledgeAcceptance,
  type FactoryKnowledgeArtifact,
  type FactoryKnowledgeBrief,
  type FactoryKnowledgeTask,
  type FactoryKnowledgeTaskReadResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeFactoryKnowledgeFailure,
  EMPTY_FACTORY_KNOWLEDGE_DRAFT,
  FACTORY_KNOWLEDGE_LIMITS,
  factoryKnowledgeAction,
  factoryKnowledgeArtifactView,
  factoryKnowledgeCreatePayload,
  factoryKnowledgeDeliverablePathProblem,
  factoryKnowledgeDraftProblem,
  factoryKnowledgePreview,
  formatFactoryBytes,
  sortFactoryKnowledgeBriefs,
} from "./factoryKnowledge";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");

function brief(overrides: Partial<FactoryKnowledgeBrief> = {}): FactoryKnowledgeBrief {
  return {
    id: "brief:1",
    projectId,
    title: "Survey",
    question: "What changed?",
    deliverablePath: "DELIVERABLE.md",
    inputs: [],
    acceptanceCriteria: "",
    revision: "r".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: environmentId,
    supersededBy: null,
    ...overrides,
  };
}

function task(
  status: FactoryKnowledgeTask["status"],
  overrides: Partial<FactoryKnowledgeTask> = {},
): FactoryKnowledgeTask {
  return {
    briefId: "brief:1",
    threadId: ThreadId.make("thread-1"),
    status,
    folderPath: "/managed/thread-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    creationSource: "mobile",
    ...overrides,
  };
}

function artifact(sha256: string): FactoryKnowledgeArtifact {
  return {
    path: "DELIVERABLE.md",
    sha256,
    bytes: 12,
    preview: "hello",
    observedAt: "2026-01-01T00:00:00.000Z",
  };
}

function acceptance(sha256: string): FactoryKnowledgeAcceptance {
  return {
    id: "acceptance-1",
    briefId: "brief:1",
    threadId: ThreadId.make("thread-1"),
    projectId,
    artifactPath: "DELIVERABLE.md",
    sha256,
    bytes: 12,
    acceptedAt: "2026-01-01T00:00:00.000Z",
    acceptedBy: environmentId,
  };
}

function read(overrides: Partial<FactoryKnowledgeTaskReadResult> = {}) {
  return {
    brief: brief(),
    task: task("idle"),
    artifact: null,
    acceptance: null,
    current: false,
    artifactIssue: null,
    ...overrides,
  } satisfies FactoryKnowledgeTaskReadResult;
}

describe("factoryKnowledgeDeliverablePathProblem", () => {
  it("accepts relative paths inside the folder", () => {
    expect(factoryKnowledgeDeliverablePathProblem("DELIVERABLE.md")).toBeNull();
    expect(factoryKnowledgeDeliverablePathProblem("notes/answer.md")).toBeNull();
    expect(factoryKnowledgeDeliverablePathProblem("docs/.github/x.md")).toBeNull();
  });

  it("refuses paths that escape the folder or land in .git", () => {
    for (const path of ["", "  ", "/abs.md", "\\abs.md", "C:/x.md", "../x", "a/../x", ".git/x"]) {
      expect(factoryKnowledgeDeliverablePathProblem(path), path).not.toBeNull();
    }
    expect(factoryKnowledgeDeliverablePathProblem(".GIT/config")).not.toBeNull();
    expect(factoryKnowledgeDeliverablePathProblem("a//b.md")).not.toBeNull();
    expect(factoryKnowledgeDeliverablePathProblem("./a.md")).not.toBeNull();
  });
});

describe("factoryKnowledgeDraftProblem", () => {
  const ready = { ...EMPTY_FACTORY_KNOWLEDGE_DRAFT, title: "Survey", question: "What?" };

  it("defaults the deliverable path and accepts a minimal brief", () => {
    expect(EMPTY_FACTORY_KNOWLEDGE_DRAFT.deliverablePath).toBe("DELIVERABLE.md");
    expect(factoryKnowledgeDraftProblem(ready)).toBeNull();
  });

  it("requires a title and question", () => {
    expect(factoryKnowledgeDraftProblem({ ...ready, title: "  " })).toBe("Enter a title.");
    expect(factoryKnowledgeDraftProblem({ ...ready, question: "" })).toContain("question");
  });

  it("enforces contract lengths and the input count", () => {
    expect(
      factoryKnowledgeDraftProblem({
        ...ready,
        title: "x".repeat(FACTORY_KNOWLEDGE_LIMITS.title + 1),
      }),
    ).toContain("title");
    const input = { label: "a", content: "" };
    expect(
      factoryKnowledgeDraftProblem({
        ...ready,
        inputs: Array.from({ length: FACTORY_KNOWLEDGE_LIMITS.inputs + 1 }, () => input),
      }),
    ).toContain(`at most ${FACTORY_KNOWLEDGE_LIMITS.inputs}`);
    expect(factoryKnowledgeDraftProblem({ ...ready, inputs: [{ label: " ", content: "x" }] })).toBe(
      "Input 1 needs a label.",
    );
  });

  it("reports an invalid deliverable path", () => {
    expect(factoryKnowledgeDraftProblem({ ...ready, deliverablePath: "../x" })).toContain("..");
  });
});

describe("factoryKnowledgeCreatePayload", () => {
  it("trims identifiers but keeps free text byte for byte", () => {
    expect(
      factoryKnowledgeCreatePayload({
        title: "  Survey ",
        question: " What?\n",
        deliverablePath: " out.md ",
        inputs: [{ label: " Notes ", content: "  raw  " }],
        acceptanceCriteria: " Cite sources ",
      }),
    ).toEqual({
      title: "Survey",
      question: " What?\n",
      deliverablePath: "out.md",
      inputs: [{ label: "Notes", content: "  raw  " }],
      acceptanceCriteria: " Cite sources ",
    });
  });
});

describe("sortFactoryKnowledgeBriefs", () => {
  it("lists the newest brief first without mutating the input", () => {
    const older = brief({ id: "brief:old", createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = brief({ id: "brief:new", createdAt: "2026-02-01T00:00:00.000Z" });
    const input = [older, newer];
    expect(sortFactoryKnowledgeBriefs(input).map((entry) => entry.id)).toEqual([
      "brief:new",
      "brief:old",
    ]);
    expect(input[0]).toBe(older);
  });
});

describe("factoryKnowledgeAction", () => {
  it("starts an unstarted brief and refuses a superseded one", () => {
    expect(factoryKnowledgeAction(brief(), null).kind).toBe("start");
    expect(factoryKnowledgeAction(brief({ supersededBy: "brief:2" }), null).kind).toBe(
      "unavailable",
    );
  });

  it("follows the issue task semantics", () => {
    expect(factoryKnowledgeAction(brief(), task("launching")).kind).toBe("resume");
    expect(factoryKnowledgeAction(brief(), task("missing")).kind).toBe("restart");
    expect(factoryKnowledgeAction(brief(), task("running")).kind).toBe("open");
    // A superseded brief keeps its live thread reachable but never starts a new attempt.
    expect(factoryKnowledgeAction(brief({ supersededBy: "brief:2" }), task("idle")).kind).toBe(
      "open",
    );
    expect(factoryKnowledgeAction(brief({ supersededBy: "brief:2" }), task("missing")).kind).toBe(
      "unavailable",
    );
  });
});

describe("factoryKnowledgeArtifactView", () => {
  it("reports no artifact yet with the deliverable path", () => {
    expect(factoryKnowledgeArtifactView(read())).toEqual({
      kind: "none",
      artifact: null,
      unavailable: "No artifact yet at DELIVERABLE.md.",
    });
  });

  it("explains why an artifact can't be read", () => {
    expect(factoryKnowledgeArtifactView(read({ artifactIssue: "too-large" }))).toMatchObject({
      unavailable: "The artifact is too large to read and accept.",
    });
    expect(
      factoryKnowledgeArtifactView(read({ task: task("idle", { folderPath: null }) })),
    ).toMatchObject({ unavailable: expect.stringContaining("folder") });
  });

  it("offers an unaccepted artifact for acceptance", () => {
    expect(
      factoryKnowledgeArtifactView(read({ artifact: artifact("a".repeat(64)) })),
    ).toMatchObject({ kind: "none", unavailable: null });
  });

  it("distinguishes current, changed, and unverifiable acceptance", () => {
    const sha = "a".repeat(64);
    expect(
      factoryKnowledgeArtifactView(
        read({ artifact: artifact(sha), acceptance: acceptance(sha), current: true }),
      ).kind,
    ).toBe("current");
    expect(
      factoryKnowledgeArtifactView(
        read({ artifact: artifact("b".repeat(64)), acceptance: acceptance(sha), current: false }),
      ).kind,
    ).toBe("changed");
    expect(
      factoryKnowledgeArtifactView(
        read({ acceptance: acceptance(sha), artifactIssue: "unreadable" }),
      ),
    ).toEqual({
      kind: "unverifiable",
      acceptance: acceptance(sha),
      unavailable: "The artifact exists but can't be read.",
    });
  });

  it("never claims a match the digests contradict", () => {
    expect(
      factoryKnowledgeArtifactView(
        read({
          artifact: artifact("b".repeat(64)),
          acceptance: acceptance("a".repeat(64)),
          current: true,
        }),
      ).kind,
    ).toBe("changed");
  });
});

describe("factoryKnowledgePreview", () => {
  it("bounds the rendered prefix and strips disguising characters", () => {
    expect(factoryKnowledgePreview(null)).toBeNull();
    expect(factoryKnowledgePreview("a\r\nb\u202Ec")).toEqual({ text: "a\nbc", truncated: false });
    const long = factoryKnowledgePreview("x".repeat(10_000));
    expect(long?.truncated).toBe(true);
    expect(long?.text.length).toBeLessThan(10_000);
  });
});

describe("formatFactoryBytes", () => {
  it("formats sizes", () => {
    expect(formatFactoryBytes(1)).toBe("1 byte");
    expect(formatFactoryBytes(12)).toBe("12 bytes");
    expect(formatFactoryBytes(2048)).toBe("2.0 KB");
    expect(formatFactoryBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("describeFactoryKnowledgeFailure", () => {
  it("maps stale-review reasons to changed so the review can't be confirmed again", () => {
    for (const reason of ["revision-mismatch", "unknown-brief", "artifact-changed"] as const) {
      expect(describeFactoryKnowledgeFailure(new FactoryKnowledgeError({ reason }), "x").kind).toBe(
        "changed",
      );
    }
  });

  it("points an already-accepted refusal at Re-accept", () => {
    expect(
      describeFactoryKnowledgeFailure(
        new FactoryKnowledgeError({ reason: "already-accepted" }),
        "x",
      ).detail,
    ).toContain("Re-accept");
  });

  it("keeps authorization failures and falls back for unknown errors", () => {
    expect(
      describeFactoryKnowledgeFailure(
        new EnvironmentAuthorizationError({
          message: "nope",
          requiredScope: "orchestration:operate",
        }),
        "x",
      ).kind,
    ).toBe("auth");
    expect(describeFactoryKnowledgeFailure(new Error("boom"), "Couldn't start")).toEqual({
      kind: "error",
      title: "Couldn't start",
      detail: "boom",
    });
  });
});
