import {
  EnvironmentAuthorizationError,
  FactoryIssueError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryIssue,
  type FactoryIssueListResult,
  type FactoryIssueTask,
  type FactoryRepository,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyFactoryIssuePage,
  describeFactoryFailure,
  EMPTY_FACTORY_ISSUE_PAGES,
  factoryIssueAction,
  factoryIssueStartKey,
  factoryRepositoryLabel,
  safeFactoryIssueBody,
  safeFactoryIssueText,
  safeFactoryIssueUrl,
} from "./factoryIssues";

const repository: FactoryRepository = {
  provider: "github",
  host: "github.com",
  repository: "owner/name",
  canonicalKey: "github.com/owner/name",
  url: "https://github.com/owner/name",
};

function task(status: FactoryIssueTask["status"]): FactoryIssueTask {
  return {
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make("thread-1"),
    status,
    baseRef: "0123456789abcdef",
    createdAt: "2026-01-01T00:00:00.000Z",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
    runtimeMode: "approval-required",
    interactionMode: "default",
  };
}

function issue(overrides: Partial<FactoryIssue> = {}): FactoryIssue {
  return {
    number: 1,
    revision: "a".repeat(64),
    title: "Fix it",
    body: null,
    state: "open",
    url: "https://github.com/owner/name/issues/1",
    labels: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    task: null,
    ...overrides,
  };
}

function page(issues: FactoryIssue[], nextPage: number | null): FactoryIssueListResult {
  return { repository, issues, nextPage, fetchedAt: "2026-01-01T00:00:00.000Z" };
}

describe("applyFactoryIssuePage", () => {
  it("replaces everything on the first page", () => {
    const loaded = applyFactoryIssuePage(EMPTY_FACTORY_ISSUE_PAGES, 1, page([issue()], 2));
    const refreshed = applyFactoryIssuePage(loaded, 1, page([issue({ number: 9 })], null));
    expect(refreshed.issues.map((entry) => entry.number)).toEqual([9]);
    expect(refreshed.nextPage).toBeNull();
  });

  it("appends later pages and keeps an empty page continuable", () => {
    const first = applyFactoryIssuePage(
      EMPTY_FACTORY_ISSUE_PAGES,
      1,
      page([issue({ number: 1 }), issue({ number: 2 })], 2),
    );
    const empty = applyFactoryIssuePage(first, 2, page([], 3));
    expect(empty.issues).toHaveLength(2);
    expect(empty.nextPage).toBe(3);
    const third = applyFactoryIssuePage(empty, 3, page([issue({ number: 3 })], null));
    expect(third.issues.map((entry) => entry.number)).toEqual([1, 2, 3]);
  });

  it("keeps the earliest position of an issue repeated on a later page with newer data", () => {
    const first = applyFactoryIssuePage(
      EMPTY_FACTORY_ISSUE_PAGES,
      1,
      page([issue({ number: 1 }), issue({ number: 2 })], 2),
    );
    const second = applyFactoryIssuePage(
      first,
      2,
      page([issue({ number: 1, task: task("running") }), issue({ number: 3 })], null),
    );
    expect(second.issues.map((entry) => entry.number)).toEqual([1, 2, 3]);
    expect(second.issues[0]?.task?.status).toBe("running");
  });

  it("replaces loaded rows when the project origin changes between pages", () => {
    const first = applyFactoryIssuePage(EMPTY_FACTORY_ISSUE_PAGES, 1, page([issue()], 2));
    const second = applyFactoryIssuePage(first, 2, {
      ...page([issue({ number: 9, url: "https://github.com/other/repository/issues/9" })], 3),
      repository: {
        ...repository,
        repository: "other/repository",
        canonicalKey: "github.com/other/repository",
        url: "https://github.com/other/repository",
      },
    });
    expect(second.repository?.canonicalKey).toBe("github.com/other/repository");
    expect(second.issues.map((entry) => entry.number)).toEqual([9]);
  });
});

describe("factoryIssueAction", () => {
  it("starts an open issue with no task", () => {
    expect(factoryIssueAction(issue()).kind).toBe("start");
  });

  it("never starts new work for a closed issue", () => {
    expect(factoryIssueAction(issue({ state: "closed" })).kind).toBe("unavailable");
  });

  it("opens an existing task even when the issue is closed", () => {
    for (const status of ["preparing", "running", "idle", "failed", "archived"] as const) {
      const action = factoryIssueAction(issue({ state: "closed", task: task(status) }));
      expect(action.kind).toBe("open");
    }
  });

  it("requires an explicit new attempt for a deleted task", () => {
    expect(factoryIssueAction(issue({ task: task("missing") })).kind).toBe("restart");
    expect(factoryIssueAction(issue({ state: "closed", task: task("missing") })).kind).toBe(
      "unavailable",
    );
  });

  it("resumes the same reserved launch after the issue closes", () => {
    expect(factoryIssueAction(issue({ state: "closed", task: task("launching") })).kind).toBe(
      "resume",
    );
  });
});

describe("factoryIssueStartKey", () => {
  it("reuses a retry identity only for the same reviewed revision", () => {
    const input = {
      environmentId: "environment-1",
      projectId: "project-1",
      expectedRepositoryKey: repository.canonicalKey,
      issueNumber: 1,
      expectedIssueRevision: "a".repeat(64),
      restartDeleted: false,
      previousThreadId: null,
    };
    const commands = new Map([[factoryIssueStartKey(input), "original-command"]]);
    expect(commands.get(factoryIssueStartKey({ ...input }))).toBe("original-command");
    expect(
      commands.get(factoryIssueStartKey({ ...input, expectedIssueRevision: "b".repeat(64) })),
    ).toBeUndefined();
  });

  it("does not replay the attempt for a different deleted thread", () => {
    const input = {
      environmentId: "environment-1",
      projectId: "project-1",
      expectedRepositoryKey: repository.canonicalKey,
      issueNumber: 1,
      expectedIssueRevision: "a".repeat(64),
      restartDeleted: true,
      previousThreadId: "deleted-thread-1",
    };
    expect(factoryIssueStartKey(input)).not.toBe(
      factoryIssueStartKey({ ...input, previousThreadId: "deleted-thread-2" }),
    );
  });
});

describe("safeFactoryIssueText", () => {
  it("removes controls and bidirectional overrides but keeps newlines", () => {
    expect(safeFactoryIssueText("a\u202Eb\u0000c\r\nd")).toBe("abc\nd");
  });

  it("collapses runs of blank lines and bounds the length", () => {
    expect(safeFactoryIssueText("a\n\n\n\n\nb")).toBe("a\n\nb");
    expect(safeFactoryIssueText("x".repeat(50), 10)).toBe(`${"x".repeat(10)}…`);
  });

  it("treats a blank body as no body", () => {
    expect(safeFactoryIssueBody(null)).toBeNull();
    expect(safeFactoryIssueBody("  \n\u202E ")).toBeNull();
    expect(safeFactoryIssueBody("hello")).toBe("hello");
  });
});

describe("safeFactoryIssueUrl", () => {
  it("only accepts https", () => {
    expect(safeFactoryIssueUrl("https://github.com/o/n/issues/1")).toBe(
      "https://github.com/o/n/issues/1",
    );
    expect(safeFactoryIssueUrl("javascript:alert(1)")).toBeNull();
    expect(safeFactoryIssueUrl("http://github.com/o/n")).toBeNull();
    expect(safeFactoryIssueUrl("not a url")).toBeNull();
  });
});

describe("describeFactoryFailure", () => {
  it("maps typed reasons to actionable kinds", () => {
    expect(
      describeFactoryFailure(new FactoryIssueError({ reason: "authentication" }), "x").kind,
    ).toBe("auth");
    expect(
      describeFactoryFailure(new FactoryIssueError({ reason: "unsupported-provider" }), "x").kind,
    ).toBe("unsupported");
    expect(
      describeFactoryFailure(new FactoryIssueError({ reason: "rate-limited" }), "x").kind,
    ).toBe("retry");
    expect(
      describeFactoryFailure(new FactoryIssueError({ reason: "missing-repository" }), "x").kind,
    ).toBe("repository");
  });

  it("distinguishes changed source from failures that can retry the same review", () => {
    expect(
      describeFactoryFailure(new FactoryIssueError({ reason: "issue-changed" }), "x").kind,
    ).toBe("changed");
    expect(
      describeFactoryFailure(new FactoryIssueError({ reason: "launch-failure" }), "x").kind,
    ).toBe("retry");
  });

  it("reports authorization failures as not permitted", () => {
    const failure = describeFactoryFailure(
      new EnvironmentAuthorizationError({
        message: "nope",
        requiredScope: "orchestration:read",
      }),
      "x",
    );
    expect(failure.kind).toBe("auth");
  });
});

describe("factoryRepositoryLabel", () => {
  it("omits github.com and shows other hosts", () => {
    expect(factoryRepositoryLabel(repository)).toBe("owner/name");
    expect(factoryRepositoryLabel({ ...repository, host: "ghe.example.com" })).toBe(
      "ghe.example.com/owner/name",
    );
  });
});
