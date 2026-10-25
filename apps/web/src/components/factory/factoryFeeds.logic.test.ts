import {
  CommandId,
  EnvironmentAuthorizationError,
  FACTORY_FEED_INSTRUCTIONS_MAX_CHARS,
  FactoryFeedError,
  FactoryFeedSourceId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryFeedCandidate,
  type FactoryFeedSource,
  type FactoryIssueTask,
  type FactoryRepository,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFactoryFeedAdmitInput,
  checkFactoryFeedUrl,
  countFactoryFeedText,
  describeFactoryFeedFailure,
  factoryFeedCandidateBadges,
  factoryFeedRefreshAvailability,
  formatFactoryFeedCountdown,
  isFactoryFeedAdmitEnabled,
  normalizeFactoryFeedText,
  pointsAtProjectIssue,
  resolveFactoryFeedCandidateAction,
  resolveFactoryFeedDismissal,
  visibleFactoryFeedCandidates,
} from "./factoryFeeds.logic";

const sourceId = FactoryFeedSourceId.make("source-1");
const model: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const repository: FactoryRepository = {
  provider: "github",
  host: "github.com",
  repository: "owner/repo",
  canonicalKey: "github.com/owner/repo",
  url: "https://github.com/owner/repo",
};

function source(overrides: Partial<FactoryFeedSource> = {}): FactoryFeedSource {
  return {
    id: sourceId,
    projectId: ProjectId.make("project-1"),
    locator: "https://feeds.example.test/tasks.xml",
    title: "Tasks",
    status: "active",
    createdAt: "2026-10-24T00:00:00.000Z",
    lastCheckedAt: null,
    nextAllowedAt: null,
    lastError: null,
    ...overrides,
  };
}

function task(status: FactoryIssueTask["status"]): FactoryIssueTask {
  return {
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make("thread-1"),
    status,
    baseRef: "abc123",
    createdAt: "2026-10-24T00:00:00.000Z",
    modelSelection: model,
    runtimeMode: "approval-required",
    interactionMode: "default",
  };
}

function candidate(overrides: Partial<FactoryFeedCandidate> = {}): FactoryFeedCandidate {
  return {
    sourceId,
    itemKey: "guid:item-1",
    title: "Add a README",
    content: "Write one.",
    link: "https://feeds.example.test/items/1",
    publishedAt: "2026-10-24T00:00:00.000Z",
    revision: "revision-1",
    ordinal: 1,
    firstSeenAt: "2026-10-24T00:00:00.000Z",
    lastSeenAt: "2026-10-24T00:00:00.000Z",
    inWindow: true,
    disposition: "open",
    dismissalNote: null,
    forgeReference: null,
    task: null,
    ...overrides,
  };
}

const ownIssue = { host: "github.com", repository: "owner/repo", issueNumber: 12 };
const context = { source: source(), repository };

describe("checkFactoryFeedUrl", () => {
  it("accepts an absolute https address and sends it as typed, trimmed", () => {
    expect(checkFactoryFeedUrl("  https://feeds.example.test/a.xml?x=1  ")).toEqual({
      ok: true,
      url: "https://feeds.example.test/a.xml?x=1",
    });
  });

  it.each([
    ["", "Enter a feed address."],
    ["feeds.example.test/a.xml", "Enter an absolute https:// feed address."],
    ["http://feeds.example.test/a.xml", "Only https:// feeds can be bound."],
    ["ftp://feeds.example.test/a.xml", "Only https:// feeds can be bound."],
    ["https://user:secret@feeds.example.test/a.xml", "Feed addresses cannot contain credentials."],
    ["https://user@feeds.example.test/a.xml", "Feed addresses cannot contain credentials."],
  ])("rejects %j before any request is made", (value, message) => {
    expect(checkFactoryFeedUrl(value)).toEqual({ ok: false, message });
  });
});

describe("factoryFeedRefreshAvailability", () => {
  const now = Date.parse("2026-10-24T12:00:00.000Z");

  it("is ready without a floor, after it, and when the server sent an unreadable one", () => {
    expect(factoryFeedRefreshAvailability(source(), now)).toEqual({ kind: "ready" });
    expect(
      factoryFeedRefreshAvailability(source({ nextAllowedAt: "2026-10-24T12:00:00.000Z" }), now),
    ).toEqual({ kind: "ready" });
    expect(
      factoryFeedRefreshAvailability(source({ nextAllowedAt: "2026-10-24T11:59:00.000Z" }), now),
    ).toEqual({ kind: "ready" });
    expect(factoryFeedRefreshAvailability(source({ nextAllowedAt: "not a date" }), now)).toEqual({
      kind: "ready",
    });
  });

  it("counts down to the server's floor and opens exactly when it passes", () => {
    const throttled = source({ nextAllowedAt: "2026-10-24T12:01:05.000Z" });
    expect(factoryFeedRefreshAvailability(throttled, now)).toEqual({
      kind: "waiting",
      remainingMs: 65_000,
      label: "1m 5s",
    });
    expect(factoryFeedRefreshAvailability(throttled, now + 64_001)).toEqual({
      kind: "waiting",
      remainingMs: 999,
      label: "1s",
    });
    expect(factoryFeedRefreshAvailability(throttled, now + 65_000)).toEqual({ kind: "ready" });
  });

  it("never offers a check for an unbound source, whatever its floor says", () => {
    expect(factoryFeedRefreshAvailability(source({ status: "suspended" }), now)).toEqual({
      kind: "unbound",
    });
  });

  it.each([
    [1, "1s"],
    [999, "1s"],
    [59_000, "59s"],
    [59_001, "1m"],
    [61_000, "1m 1s"],
    [3_600_000, "1h"],
    [3_660_000, "1h 1m"],
  ])("formats %d ms as %s", (ms, label) => {
    expect(formatFactoryFeedCountdown(ms)).toBe(label);
  });
});

describe("candidate visibility and labels", () => {
  const rows = [
    candidate({ itemKey: "guid:open" }),
    candidate({ itemKey: "guid:dismissed", disposition: "dismissed" }),
    candidate({ itemKey: "guid:retracted", disposition: "retracted" }),
    candidate({ itemKey: "guid:unreviewable", disposition: "unreviewable" }),
    candidate({ itemKey: "guid:elsewhere", sourceId: FactoryFeedSourceId.make("source-2") }),
  ];

  it("hides only dismissed items by default and keeps flagged ones visible", () => {
    expect(visibleFactoryFeedCandidates(rows, sourceId, false).map((row) => row.itemKey)).toEqual([
      "guid:open",
      "guid:retracted",
      "guid:unreviewable",
    ]);
    expect(visibleFactoryFeedCandidates(rows, sourceId, true).map((row) => row.itemKey)).toEqual([
      "guid:open",
      "guid:dismissed",
      "guid:retracted",
      "guid:unreviewable",
    ]);
  });

  it("labels retraction, unreviewable items, absence from the feed and edits", () => {
    expect(factoryFeedCandidateBadges(candidate())).toEqual([]);
    expect(factoryFeedCandidateBadges(candidate({ disposition: "retracted" }))).toEqual([
      { label: "Retracted by publisher", variant: "error" },
    ]);
    expect(factoryFeedCandidateBadges(candidate({ disposition: "unreviewable" }))).toEqual([
      { label: "Unreviewable", variant: "error" },
    ]);
    expect(factoryFeedCandidateBadges(candidate({ inWindow: false, ordinal: 3 }))).toEqual([
      { label: "Not in current feed", variant: "outline" },
      { label: "Edited · revision 3", variant: "info" },
    ]);
  });
});

describe("pointsAtProjectIssue", () => {
  it("matches the server's own-repository comparison and nothing looser", () => {
    expect(pointsAtProjectIssue(candidate({ forgeReference: ownIssue }), repository)).toBe(true);
    expect(
      pointsAtProjectIssue(
        candidate({ forgeReference: { ...ownIssue, repository: "owner/other" } }),
        repository,
      ),
    ).toBe(false);
    expect(pointsAtProjectIssue(candidate(), repository)).toBe(false);
    expect(pointsAtProjectIssue(candidate({ forgeReference: ownIssue }), null)).toBe(false);
  });
});

describe("resolveFactoryFeedCandidateAction", () => {
  it("admits an open, reviewable item on an active source", () => {
    expect(resolveFactoryFeedCandidateAction(candidate(), context)).toEqual({ kind: "admit" });
  });

  it("still admits an item that has left the feed window, since absence is never deletion", () => {
    expect(resolveFactoryFeedCandidateAction(candidate({ inWindow: false }), context)).toEqual({
      kind: "admit",
    });
  });

  it.each([
    ["retracted", "The publisher retracted this item."],
    [
      "unreviewable",
      "This item has no stable identity or exceeds the size bounds, so it cannot be reviewed.",
    ],
    ["dismissed", "Dismissed. Restore it to review it for admission."],
  ] as const)("never admits a %s item", (disposition, reason) => {
    expect(resolveFactoryFeedCandidateAction(candidate({ disposition }), context)).toEqual({
      kind: "unavailable",
      reason,
    });
  });

  it("refuses new work on an unbound source or a project without a repository", () => {
    expect(
      resolveFactoryFeedCandidateAction(candidate(), {
        source: source({ status: "suspended" }),
        repository,
      }),
    ).toEqual({
      kind: "unavailable",
      reason: "This source is unbound. Bind it again to admit items.",
    });
    expect(
      resolveFactoryFeedCandidateAction(candidate(), { source: source(), repository: null }).kind,
    ).toBe("unavailable");
  });

  it("sends an item that points at this project's own issue to Issues", () => {
    expect(
      resolveFactoryFeedCandidateAction(candidate({ forgeReference: ownIssue }), context),
    ).toEqual({ kind: "project-issue" });
  });

  it("admits an item that merely references another repository's issue", () => {
    expect(
      resolveFactoryFeedCandidateAction(
        candidate({ forgeReference: { ...ownIssue, repository: "owner/other" } }),
        context,
      ),
    ).toEqual({ kind: "admit" });
  });

  it("keeps an existing task reachable whatever happened to the item or the source", () => {
    const linked = task("running");
    for (const overrides of [
      { disposition: "dismissed" as const },
      { disposition: "retracted" as const },
      { disposition: "unreviewable" as const },
      { forgeReference: ownIssue },
    ]) {
      expect(
        resolveFactoryFeedCandidateAction(candidate({ ...overrides, task: linked }), context),
      ).toEqual({ kind: "open", task: linked });
    }
    expect(
      resolveFactoryFeedCandidateAction(candidate({ task: task("idle") }), {
        source: source({ status: "suspended" }),
        repository: null,
      }).kind,
    ).toBe("open");
  });

  it("resumes an interrupted launch even after the item was retracted or dismissed", () => {
    expect(
      resolveFactoryFeedCandidateAction(
        candidate({ task: task("launching"), disposition: "retracted" }),
        context,
      ),
    ).toEqual({ kind: "resume" });
    expect(
      resolveFactoryFeedCandidateAction(candidate({ task: task("launching") }), {
        source: source(),
        repository: null,
      }).kind,
    ).toBe("unavailable");
  });

  it("needs an explicit new attempt for a deleted thread, only while new work is allowed", () => {
    expect(
      resolveFactoryFeedCandidateAction(candidate({ task: task("missing") }), context),
    ).toEqual({ kind: "restart" });
    expect(
      resolveFactoryFeedCandidateAction(
        candidate({ task: task("missing"), disposition: "dismissed" }),
        context,
      ).kind,
    ).toBe("unavailable");
    expect(
      resolveFactoryFeedCandidateAction(
        candidate({ task: task("missing"), forgeReference: ownIssue }),
        context,
      ),
    ).toEqual({ kind: "project-issue" });
  });
});

describe("resolveFactoryFeedDismissal", () => {
  it("offers dismiss for an open item without a task and restore for a dismissed one", () => {
    expect(resolveFactoryFeedDismissal(candidate())).toBe("dismiss");
    expect(resolveFactoryFeedDismissal(candidate({ disposition: "dismissed" }))).toBe("restore");
    expect(
      resolveFactoryFeedDismissal(candidate({ disposition: "dismissed", task: task("idle") })),
    ).toBe("restore");
  });

  it("offers nothing for a task-bearing, retracted or unreviewable item", () => {
    expect(resolveFactoryFeedDismissal(candidate({ task: task("idle") }))).toBeNull();
    expect(resolveFactoryFeedDismissal(candidate({ disposition: "retracted" }))).toBeNull();
    expect(resolveFactoryFeedDismissal(candidate({ disposition: "unreviewable" }))).toBeNull();
  });
});

describe("admission readiness", () => {
  const ready = {
    canAdmit: true,
    pending: false,
    changed: false,
    selection: model,
    instructions: "",
  };

  it("needs the grants, a model, no request in flight and no stale-revision lockout", () => {
    expect(isFactoryFeedAdmitEnabled(ready)).toBe(true);
    expect(isFactoryFeedAdmitEnabled({ ...ready, canAdmit: false })).toBe(false);
    expect(isFactoryFeedAdmitEnabled({ ...ready, pending: true })).toBe(false);
    expect(isFactoryFeedAdmitEnabled({ ...ready, selection: null })).toBe(false);
    expect(isFactoryFeedAdmitEnabled({ ...ready, changed: true })).toBe(false);
  });

  it("allows instructions up to the server bound and no further", () => {
    const atLimit = "x".repeat(FACTORY_FEED_INSTRUCTIONS_MAX_CHARS);
    expect(isFactoryFeedAdmitEnabled({ ...ready, instructions: atLimit })).toBe(true);
    expect(isFactoryFeedAdmitEnabled({ ...ready, instructions: `${atLimit}x` })).toBe(false);
    expect(countFactoryFeedText(atLimit, FACTORY_FEED_INSTRUCTIONS_MAX_CHARS)).toEqual({
      length: FACTORY_FEED_INSTRUCTIONS_MAX_CHARS,
      label: `${FACTORY_FEED_INSTRUCTIONS_MAX_CHARS} / ${FACTORY_FEED_INSTRUCTIONS_MAX_CHARS}`,
      overLimit: false,
    });
  });

  it("counts in the same units the server bounds, not in code points", () => {
    expect(countFactoryFeedText("\u{1f600}", 10).length).toBe(2);
  });
});

describe("buildFactoryFeedAdmitInput", () => {
  const base = {
    commandId: CommandId.make("command-1"),
    projectId: ProjectId.make("project-1"),
    repository,
    candidate: candidate({ revision: "reviewed-revision" }),
    modelSelection: model,
    instructions: "",
    baseRef: undefined,
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    restartDeleted: false,
  };

  it("pins the reviewed revision, repository and item without optional fields", () => {
    expect(buildFactoryFeedAdmitInput(base)).toEqual({
      commandId: "command-1",
      projectId: "project-1",
      expectedRepositoryKey: "github.com/owner/repo",
      sourceId,
      itemKey: "guid:item-1",
      expectedRevision: "reviewed-revision",
      modelSelection: model,
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
  });

  it("sends reviewer instructions exactly as typed and omits a blank field", () => {
    expect(
      buildFactoryFeedAdmitInput({ ...base, instructions: "  Keep it\n  small.  " }),
    ).toMatchObject({
      instructions: "  Keep it\n  small.  ",
    });
    expect(buildFactoryFeedAdmitInput({ ...base, instructions: " \n\t" })).not.toHaveProperty(
      "instructions",
    );
    expect(normalizeFactoryFeedText("")).toBeUndefined();
  });

  it("marks only a confirmed new attempt as a restart and forwards a base ref", () => {
    expect(buildFactoryFeedAdmitInput(base)).not.toHaveProperty("restartDeleted");
    expect(
      buildFactoryFeedAdmitInput({ ...base, restartDeleted: true, baseRef: "release" }),
    ).toMatchObject({ restartDeleted: true, baseRef: "release" });
  });
});

describe("describeFactoryFeedFailure", () => {
  it("separates missing permission from a throttled check", () => {
    expect(
      describeFactoryFeedFailure(
        new EnvironmentAuthorizationError({
          requiredScope: "orchestration:operate",
          message: "This connection requires orchestration:operate.",
        }),
      ).kind,
    ).toBe("permission");
    expect(
      describeFactoryFeedFailure(new FactoryFeedError({ reason: "refresh-throttled" })).kind,
    ).toBe("throttled");
  });

  it("marks an edited item so confirmation cannot retry the stale review", () => {
    const failure = describeFactoryFeedFailure(
      new FactoryFeedError({ reason: "candidate-changed" }),
    );
    expect(failure.kind).toBe("changed");
    expect(failure.reason).toBe("candidate-changed");
  });

  it.each(["missing-repository", "unsupported-provider", "repository-changed"] as const)(
    "reports %s as a repository problem",
    (reason) => {
      expect(describeFactoryFeedFailure(new FactoryFeedError({ reason })).kind).toBe("repository");
    },
  );

  it("falls back to the supplied message for an unknown failure", () => {
    expect(describeFactoryFeedFailure(new Error("boom"), "Query failed.")).toMatchObject({
      kind: "other",
      message: "Query failed.",
      reason: null,
    });
  });
});
