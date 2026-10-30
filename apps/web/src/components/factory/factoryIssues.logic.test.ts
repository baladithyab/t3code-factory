import {
  CommandId,
  EnvironmentAuthorizationError,
  EnvironmentId,
  FACTORY_READINESS_OVERRIDE_REASON_MAX_CHARS,
  FACTORY_READINESS_TTL_MS,
  FactoryIssueError,
  FactoryReadinessOverrideId,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
  type FactoryIssue,
  type FactoryIssueFrontierReadResult,
  type FactoryIssueTask,
  type FactoryReadiness,
  type FactoryReadinessEdge,
  type FactoryReadinessOverride,
  type FactoryReadinessReason,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  FACTORY_OVERRIDE_ACTIONS,
  boundedIssueBody,
  buildFactoryReadinessOverrideInput,
  currentFactoryPage,
  describeFactoryFailure,
  factoryBlockersUnsupportedMessage,
  factoryFrontierPresentation as presentFrontier,
  factoryReadinessPresentation as presentReadiness,
  factoryScopeKey,
  isFactoryOverrideSubmitEnabled,
  normalizeFactoryBaseRef,
  popFactoryPage,
  pushFactoryPage,
  resolveFactoryIssueAction,
  safeExternalUrl,
  FACTORY_ISSUE_BODY_PREVIEW_LIMIT,
} from "./factoryIssues.logic";

// Fixtures read as GitHub unless a test names another host.
const factoryReadinessPresentation = (
  value: FactoryReadiness,
  now: number,
  displayName = "GitHub",
) => presentReadiness(value, now, displayName);
const factoryFrontierPresentation = (
  value: FactoryIssueFrontierReadResult,
  now: number,
  displayName = "GitHub",
) => presentFrontier(value, now, displayName);

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

  it("tells a changed blocker from a refused override", () => {
    const changed = describeFactoryFailure(new FactoryIssueError({ reason: "readiness-changed" }));
    expect(changed).toMatchObject({ kind: "changed", title: "Blocker changed" });
    const refused = describeFactoryFailure(
      new FactoryIssueError({ reason: "override-not-allowed" }),
    );
    expect(refused).toMatchObject({ kind: "other", title: "Override not allowed" });
  });

  it("names the issue host in sign-in and rate-limit titles only when it is known", () => {
    const authentication = new FactoryIssueError({ reason: "authentication" });
    expect(describeFactoryFailure(authentication).title).toBe("Sign-in required");
    expect(describeFactoryFailure(authentication, undefined, "GitLab").title).toBe(
      "GitLab sign-in required",
    );
    const rateLimited = new FactoryIssueError({ reason: "rate-limited" });
    expect(describeFactoryFailure(rateLimited).title).toBe("Rate limit reached");
    expect(describeFactoryFailure(rateLimited, undefined, "GitLab").title).toBe(
      "GitLab rate limit reached",
    );
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
    fingerprint: "fingerprint-7007",
    override: null,
    ...overrides,
  };
}

function readiness(overrides: Partial<FactoryReadiness> = {}): FactoryReadiness {
  return {
    status: "ready",
    reasons: [],
    basis: "source",
    edges: [],
    overrides: [],
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

  const reasonWords = (displayName: string): Record<FactoryReadinessReason, string> => ({
    "closed-subject": "the issue is closed",
    "open-blocker": "a blocker is still open",
    "unaccepted-blocker": "a blocker was closed without completion",
    "deleted-blocker": "a blocker was deleted",
    "inaccessible-blocker": "a blocker is not accessible",
    "moved-blocker": "a blocker moved",
    "unverified-blocker": "a blocker could not be verified",
    "partial-listing": `${displayName} returned only part of the blocker list`,
    "summary-missing": `${displayName} did not report how many blockers exist`,
    "truncated-response": "the blocker list was truncated",
    "invalid-response": `${displayName} returned a response that could not be read`,
    authentication: `${displayName} sign-in is required`,
    "rate-limited": `the ${displayName} rate limit was reached`,
    "remote-failure": `${displayName} could not be reached`,
    "capability-unsupported": `${displayName} does not expose blocking relationships`,
    cycle: "the blockers form a cycle",
    "overridden-not-ready": "a blocker is disputed",
  });

  it.each(["GitHub", "GitLab"])(
    "explains an unknown verdict with its first reason in words, naming %s",
    (displayName) => {
      for (const [reason, words] of Object.entries(reasonWords(displayName)) as Array<
        [FactoryReadinessReason, string]
      >) {
        const presentation = factoryReadinessPresentation(
          readiness({ status: "unknown", complete: false, reasons: [reason, "cycle"] }),
          observedMs,
          displayName,
        );
        expect(presentation).toMatchObject({ label: `Readiness unknown: ${words}`, tone: "info" });
      }
    },
  );

  it("never names GitHub for a host that is not GitHub", () => {
    for (const reason of Object.keys(reasonWords("GitLab")) as Array<FactoryReadinessReason>) {
      const { label } = factoryReadinessPresentation(
        readiness({ status: "unknown", reasons: [reason] }),
        observedMs,
        "GitLab",
      );
      expect(label).not.toContain("GitHub");
    }
  });

  it("reports a host without blocking relationships as unknown, not as unblocked", () => {
    const presentation = factoryReadinessPresentation(
      readiness({ status: "unknown", complete: false, reasons: ["capability-unsupported"] }),
      observedMs,
      "GitLab",
    );
    expect(presentation).toMatchObject({
      label: "Readiness unknown: GitLab does not expose blocking relationships",
      tone: "info",
    });
    expect(presentation.edgeRows).toEqual([]);
    expect(factoryBlockersUnsupportedMessage("GitLab")).toBe(
      "GitLab does not expose blocking relationships; readiness stays unknown.",
    );
  });

  it("says no reason was reported when an unknown verdict carries none", () => {
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
      targetHost: "github.com",
      targetId: 7007,
      locator: "owner/repo#7",
      url: "https://github.com/owner/repo/issues/7",
      title: "Land the schema",
      stateLabel: "Closed · completed",
      closedAt: "2026-10-20T09:00:00.000Z",
      resolutionLabel: "Accepted",
      statusLabel: "Listed",
      fingerprint: "fingerprint-7007",
      overrideAction: "dispute",
      overrideId: null,
      overrideLabel: null,
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

function waiveOverride(
  overrides: Partial<FactoryReadinessOverride> = {},
): FactoryReadinessOverride {
  return {
    id: FactoryReadinessOverrideId.make("override-waive"),
    kind: "waive",
    targetHost: "github.com",
    targetId: 7007,
    boundFingerprint: "fingerprint-7007",
    reason: "Deleted upstream and retired by hand.",
    createdAt: observedAt,
    revokedAt: null,
    status: "active",
    ...overrides,
  };
}

function disputeOverride(
  overrides: Partial<FactoryReadinessOverride> = {},
): FactoryReadinessOverride {
  return waiveOverride({
    id: FactoryReadinessOverrideId.make("override-dispute"),
    kind: "force-not-ready",
    reason: "Closed by a bot, not finished.",
    ...overrides,
  });
}

describe("factoryReadinessPresentation overrides", () => {
  it("offers Dispute only on an accepted edge and Waive only on a tombstone", () => {
    const actions = (resolution: FactoryReadinessEdge["resolution"]) =>
      factoryReadinessPresentation(
        readiness({ status: "blocked", edges: [edge({ resolution })] }),
        observedMs,
      ).edgeRows[0]?.overrideAction;
    expect(actions("accepted")).toBe("dispute");
    expect(actions("deleted")).toBe("waive");
    expect(actions("inaccessible")).toBe("waive");
    expect(actions("moved")).toBe("waive");
    expect(actions("unverified")).toBe("waive");
    // The tracker must resolve these; Factory never offers a way around them.
    expect(actions("open")).toBeNull();
    expect(actions("closed-unaccepted")).toBeNull();
  });

  it("offers nothing beside an active override, on an uncounted edge or for a closed issue", () => {
    const overridden = factoryReadinessPresentation(
      readiness({
        status: "blocked",
        edges: [
          edge({ override: disputeOverride().id }),
          edge({ targetId: 8008, resolution: "deleted", override: waiveOverride().id }),
        ],
        overrides: [disputeOverride(), waiveOverride({ targetId: 8008 })],
      }),
      observedMs,
    ).edgeRows;
    expect(overridden.map((row) => row.overrideAction)).toEqual([null, null]);
    // Revoking needs only the override id.
    expect(overridden.map((row) => row.overrideId)).toEqual([
      disputeOverride().id,
      waiveOverride().id,
    ]);

    const uncounted = factoryReadinessPresentation(
      readiness({
        status: "blocked",
        edges: [edge({ resolution: "unverified", status: "removed-at-source" })],
      }),
      observedMs,
    ).edgeRows;
    expect(uncounted[0]?.overrideAction).toBeNull();

    const closed = factoryReadinessPresentation(
      readiness({ status: "not-applicable", edges: [edge()] }),
      observedMs,
    ).edgeRows;
    expect(closed[0]?.overrideAction).toBeNull();
  });

  it("carries the fingerprint each override will bind to", () => {
    const [row] = factoryReadinessPresentation(
      readiness({ status: "blocked", edges: [edge({ fingerprint: "digest-v1-abc" })] }),
      observedMs,
    ).edgeRows;
    expect(row).toMatchObject({
      key: "github.com:7007",
      targetHost: "github.com",
      targetId: 7007,
      fingerprint: "digest-v1-abc",
    });
  });

  it("labels an override in effect with its kind and reason", () => {
    const rows = factoryReadinessPresentation(
      readiness({
        status: "blocked",
        edges: [
          edge({ override: disputeOverride().id }),
          edge({ targetId: 8008, resolution: "deleted", override: waiveOverride().id }),
          // An active id the result does not list still reads as overridden, not as untouched.
          edge({ targetId: 9009, override: FactoryReadinessOverrideId.make("missing") }),
          edge({ targetId: 1001 }),
        ],
        overrides: [disputeOverride(), waiveOverride({ targetId: 8008 })],
      }),
      observedMs,
    ).edgeRows;
    expect(rows.map((row) => row.overrideLabel)).toEqual([
      "Disputed: Closed by a bot, not finished.",
      "Waived: Deleted upstream and retired by hand.",
      "Override in effect",
      null,
    ]);
  });

  it("lists lapsed and revoked overrides apart, labelled for what happened to them", () => {
    const { edgeRows, inactiveOverrides } = factoryReadinessPresentation(
      readiness({
        status: "blocked",
        edges: [edge({ resolution: "deleted", override: waiveOverride().id })],
        overrides: [
          waiveOverride(),
          disputeOverride({
            id: FactoryReadinessOverrideId.make("override-lapsed"),
            status: "lapsed",
            reason: "Was disputed before the blocker reopened.",
          }),
          waiveOverride({
            id: FactoryReadinessOverrideId.make("override-revoked"),
            targetId: 4242,
            status: "revoked",
            revokedAt: "2026-10-25T11:00:00.000Z",
          }),
        ],
      }),
      observedMs,
    );
    // Only the active one is applied to its edge.
    expect(edgeRows.map((row) => row.overrideLabel)).toEqual([
      "Waived: Deleted upstream and retired by hand.",
    ]);
    expect(inactiveOverrides).toEqual([
      {
        key: "override-lapsed",
        locator: "owner/repo#7",
        kindLabel: "Dispute",
        statusLabel: "No longer applies",
        reason: "Was disputed before the blocker reopened.",
        createdAt: observedAt,
        revokedAt: null,
      },
      {
        key: "override-revoked",
        // The edge itself is no longer listed, so the identity stands in for the locator.
        locator: "github.com:4242",
        kindLabel: "Waiver",
        statusLabel: "Revoked",
        reason: "Deleted upstream and retired by hand.",
        createdAt: observedAt,
        revokedAt: "2026-10-25T11:00:00.000Z",
      },
    ]);
  });

  it("says when a verdict rests on waivers, counting only waivers in effect", () => {
    const ready = factoryReadinessPresentation(
      readiness({
        status: "ready",
        basis: "override",
        edges: [
          edge({ resolution: "deleted", override: waiveOverride().id }),
          edge({
            targetId: 8008,
            resolution: "moved",
            override: FactoryReadinessOverrideId.make("override-second"),
          }),
          edge({ targetId: 9009 }),
        ],
        overrides: [
          waiveOverride(),
          waiveOverride({ id: FactoryReadinessOverrideId.make("override-second"), targetId: 8008 }),
          waiveOverride({
            id: FactoryReadinessOverrideId.make("override-revoked"),
            targetId: 9009,
            status: "revoked",
          }),
        ],
      }),
      observedMs + 5 * 60_000,
    );
    expect(ready).toMatchObject({
      label: "No unresolved blockers observed 5m ago · basis: override (2 waived)",
      tone: "success",
      stale: false,
    });
    const staleReady = factoryReadinessPresentation(
      readiness({
        status: "ready",
        basis: "override",
        edges: [edge({ resolution: "deleted", override: waiveOverride().id })],
        overrides: [waiveOverride()],
      }),
      observedMs + FACTORY_READINESS_TTL_MS + 1,
    );
    expect(staleReady).toMatchObject({
      label: "No unresolved blockers observed 10m ago · basis: override (1 waived) · stale",
      tone: "info",
    });
    expect(
      factoryReadinessPresentation(readiness({ status: "ready", basis: "source" }), observedMs)
        .label,
    ).toBe("No unresolved blockers observed just now · basis: source");
  });

  it("counts a disputed blocker as unresolved and a waived one as resolved", () => {
    const mixed = factoryReadinessPresentation(
      readiness({
        status: "blocked",
        reasons: ["overridden-not-ready", "open-blocker"],
        edges: [
          edge({ override: disputeOverride().id }),
          edge({ targetId: 8008, resolution: "deleted", override: waiveOverride().id }),
          edge({ targetId: 9009, state: "open", stateReason: null, resolution: "open" }),
          edge({ targetId: 1001 }),
        ],
        overrides: [disputeOverride(), waiveOverride({ targetId: 8008 })],
      }),
      observedMs,
    );
    expect(mixed.label).toBe("Blocked: 2 unresolved blockers (1 disputed)");
    const onlyDisputed = factoryReadinessPresentation(
      readiness({
        status: "blocked",
        reasons: ["overridden-not-ready"],
        edges: [edge({ override: disputeOverride().id })],
        overrides: [disputeOverride()],
      }),
      observedMs,
    );
    expect(onlyDisputed).toMatchObject({
      label: "Blocked: 1 unresolved blocker (1 disputed)",
      tone: "warning",
    });
  });

  it("locks new decisions on a stale or partial observation but never revoking", () => {
    const stale = factoryReadinessPresentation(
      readiness({
        status: "blocked",
        edges: [edge({ override: disputeOverride().id }), edge({ targetId: 8008 })],
        overrides: [disputeOverride()],
      }),
      observedMs + FACTORY_READINESS_TTL_MS + 1,
    );
    expect(stale.overridesLockedReason).toBe(
      "This observation is stale. Refresh before changing overrides.",
    );
    // Revoking carries no fingerprint, so an old observation still allows it.
    expect(stale.edgeRows[0]?.overrideId).toBe(disputeOverride().id);

    const partial = factoryReadinessPresentation(
      readiness({ status: "unknown", complete: false, reasons: ["partial-listing"] }),
      observedMs,
    );
    expect(partial.overridesLockedReason).toBe(
      "The blocker list is incomplete. Refresh before changing overrides.",
    );
    expect(factoryReadinessPresentation(readiness(), observedMs).overridesLockedReason).toBeNull();
  });
});

describe("factoryFrontierPresentation", () => {
  function frontier(
    overrides: Partial<FactoryIssueFrontierReadResult> = {},
  ): FactoryIssueFrontierReadResult {
    return {
      repository: {
        provider: SourceControlProviderKind.make("github"),
        host: "github.com",
        repository: "owner/repo",
        canonicalKey: "github.com/owner/repo",
        url: "https://github.com/owner/repo",
      },
      parentIssueNumber: 2,
      parentTitle: "Map",
      complete: true,
      summaryTotal: 0,
      children: [],
      observedAt,
      ...overrides,
    };
  }
  const child = (
    number: number,
    overrides: Partial<FactoryIssueFrontierReadResult["children"][number]> = {},
  ): FactoryIssueFrontierReadResult["children"][number] => ({
    number,
    title: `Child ${number}`,
    state: "open",
    url: `https://github.com/owner/repo/issues/${number}`,
    assignees: [],
    readiness: readiness(),
    ...overrides,
  });

  it("lists children in the tracker's order with each one's own verdict", () => {
    const { rows, note, stale } = factoryFrontierPresentation(
      frontier({
        summaryTotal: 5,
        children: [
          child(9),
          child(3, { state: "closed", readiness: null }),
          child(5, {
            readiness: readiness({ status: "blocked", edges: [edge({ resolution: "open" })] }),
          }),
          child(4, { readiness: null, assignees: ["alice", "bob"] }),
          child(7, {
            readiness: readiness({
              status: "ready",
              basis: "override",
              edges: [edge({ resolution: "deleted", override: waiveOverride().id })],
              overrides: [waiveOverride()],
            }),
          }),
        ],
      }),
      observedMs + 5 * 60_000,
    );
    // Source order, not numeric order and not readiness order.
    expect(rows.map((row) => row.number)).toEqual([9, 3, 5, 4, 7]);
    expect(rows.map((row) => [row.verdictLabel, row.tone])).toEqual([
      ["No unresolved blockers observed 5m ago · basis: source", "success"],
      ["Closed", "neutral"],
      ["Blocked: 1 unresolved blocker", "warning"],
      ["Not observed", "info"],
      ["No unresolved blockers observed 5m ago · basis: override (1 waived)", "success"],
    ]);
    expect(rows[3]).toMatchObject({
      assignees: ["alice", "bob"],
      assigneesLabel: "alice, bob",
    });
    expect(rows[0]).toMatchObject({
      key: "9",
      title: "Child 9",
      url: "https://github.com/owner/repo/issues/9",
      state: "open",
      assigneesLabel: "Unassigned",
    });
    expect(note).toBeNull();
    expect(stale).toBe(false);
  });

  it("treats a closed child as closed even if a verdict came back with it", () => {
    const { rows } = factoryFrontierPresentation(
      frontier({ children: [child(3, { state: "closed", readiness: readiness() })] }),
      observedMs,
    );
    expect(rows[0]).toMatchObject({ verdictLabel: "Closed", tone: "neutral", state: "closed" });
  });

  it("keeps remote text inert: no unsafe link and a fallback title", () => {
    const { rows } = factoryFrontierPresentation(
      frontier({
        children: [child(3, { url: "javascript:alert(1)", title: "   " })],
      }),
      observedMs,
    );
    expect(rows[0]).toMatchObject({ url: null, title: "Title unavailable" });
  });

  it("reports an incomplete enumeration instead of presenting it as the whole list", () => {
    const partial = factoryFrontierPresentation(
      frontier({ complete: false, summaryTotal: 17, children: [child(3), child(4)] }),
      observedMs,
    );
    expect(partial.note).toBe(
      "Incomplete: GitHub reports 17 sub-issues, 2 listed here. This list may be missing some.",
    );
    expect(
      factoryFrontierPresentation(frontier({ complete: false, summaryTotal: 1 }), observedMs).note,
    ).toBe("Incomplete: GitHub reports 1 sub-issue, 0 listed here. This list may be missing some.");
    expect(
      factoryFrontierPresentation(frontier({ complete: false, summaryTotal: null }), observedMs)
        .note,
    ).toBe(
      "Incomplete: GitHub did not report how many sub-issues exist, so this list may be missing some.",
    );
  });

  it("names the host that reported the sub-issue total", () => {
    expect(
      factoryFrontierPresentation(
        frontier({ complete: false, summaryTotal: 3 }),
        observedMs,
        "GitLab",
      ).note,
    ).toBe(
      "Incomplete: GitLab reports 3 sub-issues, 0 listed here. This list may be missing some.",
    );
    expect(
      factoryFrontierPresentation(
        frontier({ complete: false, summaryTotal: null }),
        observedMs,
        "GitLab",
      ).note,
    ).toBe(
      "Incomplete: GitLab did not report how many sub-issues exist, so this list may be missing some.",
    );
  });

  it("marks the whole observation stale once it is older than the TTL", () => {
    expect(
      factoryFrontierPresentation(frontier(), observedMs + FACTORY_READINESS_TTL_MS).stale,
    ).toBe(false);
    expect(
      factoryFrontierPresentation(frontier(), observedMs + FACTORY_READINESS_TTL_MS + 1).stale,
    ).toBe(true);
  });
});

describe("readiness override submission", () => {
  const base = { canOperate: true, pending: false, changed: false, reason: "Retired by hand." };

  it("needs operate, a non-blank reason within the bound, no request in flight and no lockout", () => {
    expect(isFactoryOverrideSubmitEnabled(base)).toBe(true);
    expect(isFactoryOverrideSubmitEnabled({ ...base, canOperate: false })).toBe(false);
    expect(isFactoryOverrideSubmitEnabled({ ...base, pending: true })).toBe(false);
    expect(isFactoryOverrideSubmitEnabled({ ...base, changed: true })).toBe(false);
    expect(isFactoryOverrideSubmitEnabled({ ...base, reason: "" })).toBe(false);
    expect(isFactoryOverrideSubmitEnabled({ ...base, reason: " \n\t " })).toBe(false);
    const atLimit = "x".repeat(FACTORY_READINESS_OVERRIDE_REASON_MAX_CHARS);
    expect(isFactoryOverrideSubmitEnabled({ ...base, reason: atLimit })).toBe(true);
    expect(isFactoryOverrideSubmitEnabled({ ...base, reason: `${atLimit}x` })).toBe(false);
  });

  it("names the issue host in the dispute and waiver explanations", () => {
    for (const action of ["dispute", "waive"] as const) {
      const description = FACTORY_OVERRIDE_ACTIONS[action].description("GitLab");
      expect(description).toContain("GitLab");
      expect(description).not.toContain("GitHub");
    }
  });

  it("sends the fingerprint the reviewer saw and the kind that matches the action", () => {
    const row = {
      targetHost: "github.com",
      targetId: 7007,
      fingerprint: "digest-v1-abc",
    };
    const common = {
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project"),
      issueNumber: 12,
      row,
      reason: "  Retired by hand.  ",
    };
    expect(buildFactoryReadinessOverrideInput({ ...common, action: "waive" })).toEqual({
      commandId: "command-1",
      projectId: "project",
      issueNumber: 12,
      targetHost: "github.com",
      targetId: 7007,
      expectedFingerprint: "digest-v1-abc",
      kind: "waive",
      reason: "Retired by hand.",
    });
    expect(buildFactoryReadinessOverrideInput({ ...common, action: "dispute" }).kind).toBe(
      "force-not-ready",
    );
  });
});
