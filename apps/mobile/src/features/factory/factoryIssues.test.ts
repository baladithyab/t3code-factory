import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  FactoryAcceptanceError,
  FactoryDeliveryError,
  FactoryIssueError,
  FactoryOriginKey,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryAcceptance,
  type FactoryDeliveryIntent,
  type FactoryDeliveryPrepareResult,
  type FactoryDeliveryPullRequest,
  type FactoryIssue,
  type FactoryIssueListResult,
  type FactoryIssueTask,
  type FactoryRepository,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyFactoryIssuePage,
  describeFactoryAcceptanceFailure,
  describeFactoryDeliveryFailure,
  describeFactoryFailure,
  describeFactoryMergeFailure,
  EMPTY_FACTORY_ISSUE_PAGES,
  FACTORY_DELIVERY_ALREADY_DELIVERING,
  FACTORY_DELIVERY_HEAD_MOVED,
  FACTORY_DELIVERY_PAYLOAD_CHANGED,
  FACTORY_MERGE_ALREADY_MERGED,
  FACTORY_MERGE_ALREADY_MERGING,
  FACTORY_MERGE_DRAFT,
  FACTORY_MERGE_METHOD_CHANGED,
  FACTORY_MERGE_NOT_MERGEABLE,
  FACTORY_MERGE_NOT_PUBLISHED,
  FACTORY_MERGE_PR_HEAD_MOVED,
  factoryAcceptanceView,
  factoryDeliveryDefaultPayload,
  factoryDeliveryGrantBlocker,
  factoryDeliveryStatusView,
  factoryMergeGrantBlocker,
  factoryPullRequestHeadView,
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

describe("factoryAcceptanceView", () => {
  const acceptance: FactoryAcceptance = {
    id: "acceptance-1",
    originKey: FactoryOriginKey.make("github:github.com/owner/name#1"),
    threadId: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    headSha: "a".repeat(40),
    baseRef: "main",
    baseSha: "b".repeat(40),
    acceptedAt: "2026-01-01T00:00:00.000Z",
    acceptedBy: EnvironmentId.make("environment-1"),
    evidenceRefs: [],
  };

  it("offers the live head when nothing is accepted", () => {
    expect(
      factoryAcceptanceView({ acceptance: null, liveHeadSha: "c".repeat(40), current: false }),
    ).toEqual({ kind: "none", liveHeadSha: "c".repeat(40) });
  });

  it("reports a moved head only when the live head was observed", () => {
    expect(
      factoryAcceptanceView({ acceptance, liveHeadSha: "c".repeat(40), current: false }).kind,
    ).toBe("moved");
    expect(factoryAcceptanceView({ acceptance, liveHeadSha: null, current: false }).kind).toBe(
      "unverifiable",
    );
    expect(
      factoryAcceptanceView({ acceptance, liveHeadSha: acceptance.headSha, current: true }).kind,
    ).toBe("current");
  });
});

describe("describeFactoryAcceptanceFailure", () => {
  it("asks the reviewer to look again when the head moved", () => {
    expect(
      describeFactoryAcceptanceFailure(new FactoryAcceptanceError({ reason: "head-moved" })),
    ).toMatchObject({
      kind: "changed",
      detail: "The head moved while you were reviewing. Refresh and review again.",
    });
  });

  it("points a write-once conflict at Re-accept", () => {
    expect(
      describeFactoryAcceptanceFailure(new FactoryAcceptanceError({ reason: "already-accepted" }))
        .detail,
    ).toContain("Re-accept at current head");
  });

  it("reports authorization failures as not permitted", () => {
    expect(
      describeFactoryAcceptanceFailure(
        new EnvironmentAuthorizationError({
          message: "nope",
          requiredScope: "orchestration:operate",
        }),
      ).kind,
    ).toBe("auth");
  });
});

describe("factory delivery", () => {
  const headSha = "a".repeat(40);
  const payload = {
    title: "Fix it",
    body: "Issue: https://github.com/owner/name/issues/1",
    draft: true,
  };
  const acceptance: FactoryAcceptance = {
    id: "acceptance-1",
    originKey: FactoryOriginKey.make("github:github.com/owner/name#1"),
    threadId: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    headSha,
    baseRef: "main",
    baseSha: "b".repeat(40),
    acceptedAt: "2026-01-01T00:00:00.000Z",
    acceptedBy: EnvironmentId.make("environment-1"),
    evidenceRefs: [],
  };
  const prepared: FactoryDeliveryPrepareResult = {
    acceptance,
    current: true,
    repository,
    baseRef: "main",
    headSha,
    payload,
    payloadDigest: "d".repeat(64),
    existing: null,
    pullRequest: null,
  };
  function intent(overrides: Partial<FactoryDeliveryIntent> = {}): FactoryDeliveryIntent {
    return {
      id: "intent-1",
      originKey: acceptance.originKey,
      threadId: acceptance.threadId,
      projectId: acceptance.projectId,
      kind: "publish-pr",
      acceptanceId: acceptance.id,
      repository,
      baseRef: "main",
      baseSha: acceptance.baseSha,
      headSha,
      payload,
      payloadDigest: prepared.payloadDigest,
      grantedBy: acceptance.acceptedBy,
      grantedAt: "2026-01-01T00:00:00.000Z",
      requestCommandId: "command-1",
      status: "pending",
      remote: null,
      failure: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }
  const grantable = {
    permitted: true,
    acceptedHeadSha: headSha,
    acceptanceCurrent: true,
    liveIntent: null,
    prepared,
    draft: payload,
  };

  it("prefills a draft from the issue title and a link to it", () => {
    expect(
      factoryDeliveryDefaultPayload({
        number: 1,
        title: "  Fix it‮ ",
        url: "https://github.com/owner/name/issues/1",
      }),
    ).toEqual(payload);
    expect(
      factoryDeliveryDefaultPayload({ number: 7, title: " ", url: "javascript:alert(1)" }),
    ).toEqual({ title: "Issue #7", body: "Issue #7", draft: true });
  });

  it("grants only the exact current preview", () => {
    expect(factoryDeliveryGrantBlocker(grantable)).toBeNull();
    // A trailing space is trimmed by the server, so it is not an edit.
    expect(
      factoryDeliveryGrantBlocker({ ...grantable, draft: { ...payload, title: "Fix it " } }),
    ).toBeNull();
    expect(factoryDeliveryGrantBlocker({ ...grantable, prepared: null })).toBe(
      "Prepare a preview before granting.",
    );
  });

  it("refuses a grant whose preview no longer matches the acceptance", () => {
    expect(factoryDeliveryGrantBlocker({ ...grantable, acceptedHeadSha: "c".repeat(40) })).toBe(
      FACTORY_DELIVERY_HEAD_MOVED,
    );
    expect(
      factoryDeliveryGrantBlocker({ ...grantable, prepared: { ...prepared, current: false } }),
    ).toBe(FACTORY_DELIVERY_HEAD_MOVED);
    expect(factoryDeliveryGrantBlocker({ ...grantable, acceptanceCurrent: false })).toBe(
      "Publishing needs a current accepted commit.",
    );
  });

  it("refuses a grant after the title, body, or draft flag was edited", () => {
    for (const draft of [
      { ...payload, title: "Other" },
      { ...payload, body: "" },
      { ...payload, draft: false },
    ]) {
      expect(factoryDeliveryGrantBlocker({ ...grantable, draft })).toBe(
        FACTORY_DELIVERY_PAYLOAD_CHANGED,
      );
    }
  });

  it("allows one live intent per task, but a failed one can be granted again", () => {
    for (const status of ["pending", "sending", "unknown"] as const) {
      expect(factoryDeliveryGrantBlocker({ ...grantable, liveIntent: intent({ status }) })).toBe(
        FACTORY_DELIVERY_ALREADY_DELIVERING,
      );
    }
    expect(
      factoryDeliveryGrantBlocker({ ...grantable, liveIntent: intent({ status: "confirmed" }) }),
    ).toBe("A pull request was already published for this task.");
    expect(
      factoryDeliveryGrantBlocker({
        ...grantable,
        prepared: { ...prepared, existing: intent({ status: "failed" }) },
      }),
    ).toBeNull();
    expect(factoryDeliveryGrantBlocker({ ...grantable, permitted: false })).toContain(
      "isn't permitted",
    );
  });

  it("describes each intent status without inventing a link", () => {
    expect(factoryDeliveryStatusView(intent({ status: "sending" })).text).toBe("Publishing…");
    expect(
      factoryDeliveryStatusView(
        intent({
          status: "confirmed",
          remote: { number: 12, url: "https://github.com/owner/name/pull/12" },
        }),
      ),
    ).toEqual({
      kind: "confirmed",
      text: "Published pull request #12",
      link: { label: "Open pull request #12", url: "https://github.com/owner/name/pull/12" },
    });
    expect(
      factoryDeliveryStatusView(
        intent({ status: "confirmed", remote: { number: 12, url: "http://example.com" } }),
      ),
    ).toMatchObject({ text: "Published pull request #12", link: null });
    expect(factoryDeliveryStatusView(intent({ status: "failed", failure: "boom" })).text).toBe(
      "boom",
    );
    expect(factoryDeliveryStatusView(intent({ status: "unknown" })).text).toContain("Reconcile");
  });

  it("maps refusals to the next step a person can take", () => {
    for (const reason of ["head-moved", "acceptance-stale"] as const) {
      expect(describeFactoryDeliveryFailure(new FactoryDeliveryError({ reason })).detail).toBe(
        FACTORY_DELIVERY_HEAD_MOVED,
      );
    }
    expect(
      describeFactoryDeliveryFailure(new FactoryDeliveryError({ reason: "payload-changed" }))
        .detail,
    ).toBe(FACTORY_DELIVERY_PAYLOAD_CHANGED);
    expect(
      describeFactoryDeliveryFailure(new FactoryDeliveryError({ reason: "already-delivering" }))
        .detail,
    ).toBe(FACTORY_DELIVERY_ALREADY_DELIVERING);
    expect(
      describeFactoryDeliveryFailure(
        new EnvironmentAuthorizationError({
          message: "nope",
          requiredScope: "source-control:write",
        }),
      ).kind,
    ).toBe("auth");
  });

  describe("merge", () => {
    const pullRequest: FactoryDeliveryPullRequest = {
      number: 12,
      url: "https://github.com/owner/name/pull/12",
      headSha,
      state: "open",
      mergeability: "mergeable",
      isDraft: false,
      checksSummary: "3 passed",
      mergeMethods: ["merge", "squash", "rebase"],
    };
    const mergePrepared: FactoryDeliveryPrepareResult = {
      ...prepared,
      payload: { mergeMethod: "squash" },
      pullRequest,
    };
    const mergeGrantable = {
      permitted: true,
      acceptedHeadSha: headSha,
      acceptanceCurrent: true,
      liveIntent: null,
      prepared: mergePrepared,
      mergeMethod: "squash" as const,
    };
    const withPullRequest = (overrides: Partial<typeof pullRequest> | { headSha: null }) => ({
      ...mergeGrantable,
      prepared: { ...mergePrepared, pullRequest: { ...pullRequest, ...overrides } },
    });

    it("grants only the exact pull request head and method last prepared", () => {
      expect(factoryMergeGrantBlocker(mergeGrantable)).toBeNull();
      expect(factoryMergeGrantBlocker({ ...mergeGrantable, prepared: null })).toBe(
        "Prepare a merge preview before granting.",
      );
      expect(factoryMergeGrantBlocker({ ...mergeGrantable, mergeMethod: "rebase" })).toBe(
        FACTORY_MERGE_METHOD_CHANGED,
      );
      // A publish preview can never stand in for a merge preview.
      expect(factoryMergeGrantBlocker({ ...mergeGrantable, prepared })).toBe(
        FACTORY_MERGE_NOT_PUBLISHED,
      );
    });

    it("refuses when the pull request head is not the accepted commit", () => {
      expect(factoryMergeGrantBlocker(withPullRequest({ headSha: "c".repeat(40) }))).toBe(
        FACTORY_MERGE_PR_HEAD_MOVED,
      );
      expect(factoryMergeGrantBlocker(withPullRequest({ headSha: null }))).toBe(
        FACTORY_MERGE_PR_HEAD_MOVED,
      );
      expect(factoryMergeGrantBlocker({ ...mergeGrantable, acceptedHeadSha: "c".repeat(40) })).toBe(
        FACTORY_DELIVERY_HEAD_MOVED,
      );
      expect(factoryMergeGrantBlocker({ ...mergeGrantable, acceptanceCurrent: false })).toBe(
        "Merging needs a current accepted commit.",
      );
    });

    it("states what GitHub would refuse before the tap", () => {
      expect(factoryMergeGrantBlocker(withPullRequest({ isDraft: true }))).toBe(
        FACTORY_MERGE_DRAFT,
      );
      expect(factoryMergeGrantBlocker(withPullRequest({ mergeability: "conflicting" }))).toBe(
        FACTORY_MERGE_NOT_MERGEABLE,
      );
      // Unknown mergeability is GitHub still computing; branch protection decides at merge.
      expect(factoryMergeGrantBlocker(withPullRequest({ mergeability: "unknown" }))).toBeNull();
      expect(factoryMergeGrantBlocker(withPullRequest({ state: "merged" }))).toBe(
        FACTORY_MERGE_ALREADY_MERGED,
      );
      expect(factoryMergeGrantBlocker({ ...mergeGrantable, permitted: false })).toContain(
        "isn't permitted to merge",
      );
    });

    it("allows one live merge per task, but a failed one can be granted again", () => {
      const merging = intent({ kind: "merge-pr", payload: { mergeMethod: "squash" } });
      for (const status of ["pending", "sending", "unknown"] as const) {
        expect(
          factoryMergeGrantBlocker({ ...mergeGrantable, liveIntent: { ...merging, status } }),
        ).toBe(FACTORY_MERGE_ALREADY_MERGING);
      }
      expect(
        factoryMergeGrantBlocker({
          ...mergeGrantable,
          liveIntent: { ...merging, status: "confirmed" },
        }),
      ).toBe(FACTORY_MERGE_ALREADY_MERGED);
      expect(
        factoryMergeGrantBlocker({
          ...mergeGrantable,
          prepared: { ...mergePrepared, existing: { ...merging, status: "failed" } },
        }),
      ).toBeNull();
    });

    it("compares the pull request head with the accepted commit", () => {
      expect(factoryPullRequestHeadView(pullRequest, headSha)).toEqual({
        matches: true,
        text: "Head aaaaaaa matches the accepted commit.",
      });
      expect(factoryPullRequestHeadView(pullRequest, "c".repeat(40))).toEqual({
        matches: false,
        text: "Head aaaaaaa is not the accepted commit ccccccc.",
      });
      expect(factoryPullRequestHeadView({ ...pullRequest, headSha: null }, headSha).matches).toBe(
        false,
      );
    });

    it("labels merge rows apart from publish rows", () => {
      const merging = intent({ kind: "merge-pr", payload: { mergeMethod: "squash" } });
      expect(factoryDeliveryStatusView({ ...merging, status: "sending" }).text).toBe("Merging…");
      expect(
        factoryDeliveryStatusView({
          ...merging,
          status: "confirmed",
          remote: { number: 12, url: pullRequest.url },
        }),
      ).toEqual({
        kind: "confirmed",
        text: "Merged pull request #12",
        link: { label: "Open pull request #12", url: pullRequest.url },
      });
      expect(factoryDeliveryStatusView({ ...merging, status: "failed" }).text).toBe(
        "Merging failed.",
      );
      expect(factoryDeliveryStatusView({ ...merging, status: "unknown" })).toMatchObject({
        kind: "unknown",
        text: expect.stringContaining("merge response"),
      });
    });

    it("maps merge refusals to the next step a person can take", () => {
      const cases = [
        ["not-published", FACTORY_MERGE_NOT_PUBLISHED],
        ["pull-request-head-moved", FACTORY_MERGE_PR_HEAD_MOVED],
        ["already-merged", FACTORY_MERGE_ALREADY_MERGED],
        ["not-mergeable", FACTORY_MERGE_NOT_MERGEABLE],
        ["payload-changed", FACTORY_MERGE_METHOD_CHANGED],
        ["already-delivering", FACTORY_MERGE_ALREADY_MERGING],
        ["head-moved", FACTORY_DELIVERY_HEAD_MOVED],
      ] as const;
      for (const [reason, detail] of cases) {
        expect(describeFactoryMergeFailure(new FactoryDeliveryError({ reason })).detail).toBe(
          detail,
        );
      }
      expect(
        describeFactoryMergeFailure(new FactoryDeliveryError({ reason: "persistence-failure" }))
          .title,
      ).toBe("Couldn't merge");
    });
  });
});
