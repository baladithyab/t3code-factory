import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  FACTORY_READINESS_TTL_MS,
  FactoryIssueError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryIssue,
  type FactoryIssueTask,
  type FactoryReadiness,
  type FactoryReadinessEdge,
  type FactoryReadinessReason,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boundedIssueBody,
  currentFactoryPage,
  describeFactoryFailure,
  factoryReadinessPresentation,
  factoryScopeKey,
  normalizeFactoryBaseRef,
  popFactoryPage,
  pushFactoryPage,
  resolveFactoryIssueAction,
  safeExternalUrl,
  FACTORY_ISSUE_BODY_PREVIEW_LIMIT,
} from "./factoryIssues.logic";

function task(status: FactoryIssueTask["status"]): FactoryIssueTask {
  return {
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make("thread-1"),
    status,
    baseRef: "abc123",
    createdAt: "2026-10-23T00:00:00.000Z",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
    runtimeMode: "approval-required",
    interactionMode: "default",
  };
}

function issue(state: FactoryIssue["state"], linked: FactoryIssueTask | null): FactoryIssue {
  return {
    number: 7,
    title: "Fix it",
    body: null,
    revision: "a".repeat(64),
    state,
    url: "https://github.com/o/r/issues/7",
    labels: [],
    updatedAt: "2026-10-23T00:00:00.000Z",
    task: linked,
  };
}

describe("resolveFactoryIssueAction", () => {
  it("starts open issues without a task and refuses closed ones", () => {
    expect(resolveFactoryIssueAction(issue("open", null))).toEqual({ kind: "start" });
    expect(resolveFactoryIssueAction(issue("closed", null)).kind).toBe("unavailable");
  });

  it("keeps an existing task openable on a closed issue", () => {
    const linked = task("idle");
    expect(resolveFactoryIssueAction(issue("closed", linked))).toEqual({
      kind: "open",
      task: linked,
    });
  });

  it("opens archived and failed tasks instead of starting a duplicate", () => {
    expect(resolveFactoryIssueAction(issue("open", task("archived"))).kind).toBe("open");
    expect(resolveFactoryIssueAction(issue("open", task("failed"))).kind).toBe("open");
  });

  it("requires an explicit new attempt for a deleted thread, only while the issue is open", () => {
    expect(resolveFactoryIssueAction(issue("open", task("missing")))).toEqual({ kind: "restart" });
    expect(resolveFactoryIssueAction(issue("closed", task("missing"))).kind).toBe("unavailable");
  });

  it("resumes an interrupted launch even when its source issue is now closed", () => {
    expect(resolveFactoryIssueAction(issue("open", task("launching")))).toEqual({
      kind: "resume",
    });
    expect(resolveFactoryIssueAction(issue("closed", task("launching")))).toEqual({
      kind: "resume",
    });
  });
});

describe("describeFactoryFailure", () => {
  it("separates missing permission from repository problems", () => {
    const permission = describeFactoryFailure(
      new EnvironmentAuthorizationError({
        requiredScope: "orchestration:read",
        message: "This connection requires orchestration:read.",
      }),
    );
    expect(permission.kind).toBe("permission");
    expect(
      describeFactoryFailure(new FactoryIssueError({ reason: "unsupported-provider" })).kind,
    ).toBe("unsupported");
    expect(
      describeFactoryFailure(new FactoryIssueError({ reason: "missing-repository" })).kind,
    ).toBe("repository");
  });

  it("distinguishes changed source content so confirmation cannot retry the stale review", () => {
    const failure = describeFactoryFailure(new FactoryIssueError({ reason: "issue-changed" }));
    expect(failure.kind).toBe("changed");
  });
});

describe("inbox scope helpers", () => {
  it("returns to the page that led to the current one", () => {
    const second = pushFactoryPage([1], 2);
    const third = pushFactoryPage(second, 5);
    expect(currentFactoryPage(third)).toBe(5);
    expect(currentFactoryPage(popFactoryPage(third))).toBe(2);
    expect(popFactoryPage([1])).toEqual([1]);
  });

  it("keys scope by environment, project and state", () => {
    const environmentId = EnvironmentId.make("env");
    const projectId = ProjectId.make("project");
    expect(factoryScopeKey(environmentId, projectId, "open")).not.toBe(
      factoryScopeKey(environmentId, projectId, "closed"),
    );
  });
});

describe("untrusted issue content", () => {
  it("links only http(s) urls", () => {
    expect(safeExternalUrl("https://github.com/o/r/issues/1")).toBe(
      "https://github.com/o/r/issues/1",
    );
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("not a url")).toBeNull();
  });

  it("bounds the rendered body", () => {
    const body = "x".repeat(FACTORY_ISSUE_BODY_PREVIEW_LIMIT + 10);
    const bounded = boundedIssueBody(body);
    expect(bounded.truncated).toBe(true);
    expect(bounded.text).toHaveLength(FACTORY_ISSUE_BODY_PREVIEW_LIMIT);
    expect(boundedIssueBody(null)).toEqual({ text: "", truncated: false });
  });

  it("treats a blank base ref as the server's current HEAD", () => {
    expect(normalizeFactoryBaseRef("   ")).toBeUndefined();
    expect(normalizeFactoryBaseRef(" main ")).toBe("main");
  });
});

const observedAt = "2026-10-25T12:00:00.000Z";
const observedMs = Date.parse(observedAt);

function edge(overrides: Partial<FactoryReadinessEdge> = {}): FactoryReadinessEdge {
  return {
    targetId: 7007,
    targetHost: "github.com",
    targetRepository: "owner/repo",
    targetNumber: 7,
    targetUrl: "https://github.com/owner/repo/issues/7",
    title: "Land the schema",
    state: "closed",
    stateReason: "completed",
    closedAt: "2026-10-20T09:00:00.000Z",
    resolution: "accepted",
    status: "present",
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    ...overrides,
  };
}

function readiness(overrides: Partial<FactoryReadiness> = {}): FactoryReadiness {
  return {
    status: "ready",
    reasons: [],
    edges: [],
    complete: true,
    listedCount: 0,
    summaryTotal: 0,
    observedAt,
    ...overrides,
  };
}

describe("factoryReadinessPresentation", () => {
  it("reports observed absence of blockers with its time and basis, never a bare Ready", () => {
    const fresh = factoryReadinessPresentation(readiness(), observedMs + 5 * 60_000);
    expect(fresh).toMatchObject({
      label: "No unresolved blockers observed 5m ago · basis: source",
      tone: "success",
      stale: false,
    });
    expect(factoryReadinessPresentation(readiness(), observedMs).label).toBe(
      "No unresolved blockers observed just now · basis: source",
    );
    for (const status of ["ready", "blocked", "unknown", "not-applicable"] as const) {
      const { label } = factoryReadinessPresentation(readiness({ status }), observedMs);
      expect(label).not.toMatch(/\bready\b/i);
    }
  });

  it("marks an observation stale only once it is older than the TTL", () => {
    const atTtl = factoryReadinessPresentation(readiness(), observedMs + FACTORY_READINESS_TTL_MS);
    expect(atTtl.stale).toBe(false);
    expect(atTtl.label).not.toContain("stale");
    const pastTtl = factoryReadinessPresentation(
      readiness(),
      observedMs + FACTORY_READINESS_TTL_MS + 1,
    );
    expect(pastTtl).toMatchObject({
      label: "No unresolved blockers observed 10m ago · basis: source · stale",
      stale: true,
      // Old evidence no longer reads as a positive signal.
      tone: "info",
    });
    const staleBlocked = factoryReadinessPresentation(
      readiness({ status: "blocked", edges: [edge({ resolution: "open" })] }),
      observedMs + FACTORY_READINESS_TTL_MS + 1,
    );
    expect(staleBlocked).toMatchObject({
      label: "Blocked: 1 unresolved blocker · stale",
      tone: "warning",
      stale: true,
    });
  });

  it("counts unresolved blockers, leaving out accepted edges and ones the tracker removed", () => {
    const blocked = factoryReadinessPresentation(
      readiness({
        status: "blocked",
        edges: [
          edge({ targetId: 1 }),
          edge({ targetId: 2, state: "open", stateReason: null, resolution: "open" }),
          edge({ targetId: 3, stateReason: "not_planned", resolution: "closed-unaccepted" }),
          edge({
            targetId: 4,
            state: null,
            stateReason: null,
            closedAt: null,
            resolution: "unverified",
            status: "removed-at-source",
          }),
        ],
      }),
      observedMs,
    );
    expect(blocked).toMatchObject({ label: "Blocked: 2 unresolved blockers", tone: "warning" });
    expect(
      factoryReadinessPresentation(
        readiness({ status: "blocked", edges: [edge({ resolution: "deleted" })] }),
        observedMs,
      ).label,
    ).toBe("Blocked: 1 unresolved blocker");
  });

  it("explains an unknown verdict with its first reason in words", () => {
    const expected: Record<FactoryReadinessReason, string> = {
      "closed-subject": "the issue is closed",
      "open-blocker": "a blocker is still open",
      "unaccepted-blocker": "a blocker was closed without completion",
      "deleted-blocker": "a blocker was deleted",
      "inaccessible-blocker": "a blocker is not accessible",
      "moved-blocker": "a blocker moved",
      "unverified-blocker": "a blocker could not be verified",
      "partial-listing": "GitHub returned only part of the blocker list",
      "summary-missing": "GitHub did not report how many blockers exist",
      "truncated-response": "the blocker list was truncated",
      "invalid-response": "GitHub returned a response that could not be read",
      authentication: "GitHub sign-in is required",
      "rate-limited": "the GitHub rate limit was reached",
      "remote-failure": "GitHub could not be reached",
      cycle: "the blockers form a cycle",
    };
    for (const [reason, words] of Object.entries(expected) as Array<
      [FactoryReadinessReason, string]
    >) {
      const presentation = factoryReadinessPresentation(
        readiness({ status: "unknown", complete: false, reasons: [reason, "cycle"] }),
        observedMs,
      );
      expect(presentation).toMatchObject({ label: `Readiness unknown: ${words}`, tone: "info" });
    }
    expect(
      factoryReadinessPresentation(readiness({ status: "unknown", reasons: [] }), observedMs).label,
    ).toBe("Readiness unknown: no reason reported");
  });

  it("says a closed issue has no readiness to report", () => {
    expect(
      factoryReadinessPresentation(
        readiness({ status: "not-applicable", reasons: ["closed-subject"] }),
        observedMs,
      ),
    ).toMatchObject({ label: "Not applicable (closed)", tone: "neutral", stale: false });
  });

  it("labels each edge by how it resolved and how the tracker lists it", () => {
    const rows = factoryReadinessPresentation(
      readiness({
        status: "blocked",
        edges: [
          edge(),
          edge({
            targetId: 8008,
            targetNumber: 8,
            targetRepository: "owner/other",
            targetUrl: "https://github.com/owner/other/issues/8",
            title: "  Pick a transport ",
            state: "open",
            stateReason: null,
            closedAt: null,
            resolution: "open",
          }),
          edge({ targetId: 9009, stateReason: "not_planned", resolution: "closed-unaccepted" }),
          edge({ targetId: 1001, stateReason: null, resolution: "closed-unaccepted" }),
          edge({
            targetId: 1002,
            title: null,
            state: null,
            stateReason: null,
            closedAt: null,
            targetUrl: "javascript:alert(1)",
            resolution: "deleted",
            status: "deleted",
          }),
          edge({ targetId: 1003, resolution: "inaccessible", status: "inaccessible" }),
          edge({ targetId: 1004, resolution: "moved", status: "moved" }),
          edge({ targetId: 1005, resolution: "unverified", status: "unverified" }),
          edge({ targetId: 1006, resolution: "unverified", status: "removed-at-source" }),
        ],
      }),
      observedMs,
    ).edgeRows;

    expect(rows.map(({ key }) => key)).toEqual([
      "github.com:7007",
      "github.com:8008",
      "github.com:9009",
      "github.com:1001",
      "github.com:1002",
      "github.com:1003",
      "github.com:1004",
      "github.com:1005",
      "github.com:1006",
    ]);
    expect(rows[0]).toEqual({
      key: "github.com:7007",
      locator: "owner/repo#7",
      url: "https://github.com/owner/repo/issues/7",
      title: "Land the schema",
      stateLabel: "Closed · completed",
      closedAt: "2026-10-20T09:00:00.000Z",
      resolutionLabel: "Accepted",
      statusLabel: "Listed",
    });
    expect(rows[1]).toMatchObject({
      locator: "owner/other#8",
      url: "https://github.com/owner/other/issues/8",
      title: "Pick a transport",
      stateLabel: "Open",
      closedAt: null,
      resolutionLabel: "Open, unresolved",
    });
    expect(rows[2]).toMatchObject({
      stateLabel: "Closed · not planned",
      resolutionLabel: "Closed, not accepted (not planned)",
    });
    expect(rows[3]).toMatchObject({
      stateLabel: "Closed",
      resolutionLabel: "Closed, not accepted (no reason recorded)",
    });
    // Remote links are untrusted, and a deleted blocker has no title or state left to show.
    expect(rows[4]).toMatchObject({
      url: null,
      title: "Title unavailable",
      stateLabel: "State unknown",
      resolutionLabel: "Deleted, counts as unresolved",
      statusLabel: "Deleted at source",
    });
    expect(
      rows.slice(5).map(({ resolutionLabel, statusLabel }) => [resolutionLabel, statusLabel]),
    ).toEqual([
      ["Inaccessible, cannot verify", "Inaccessible"],
      ["Moved, cannot verify", "Moved"],
      ["Could not be verified", "Unverified"],
      ["Not counted, removed at source", "No longer listed"],
    ]);
  });
});
