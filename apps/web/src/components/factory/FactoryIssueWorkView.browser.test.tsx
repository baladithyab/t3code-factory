import {
  EnvironmentId,
  FactoryIssueError,
  FactoryReadinessOverrideId,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
  type FactoryDeliveryIntent,
  type FactoryDeliveryPrepareResult,
  type FactoryIssue,
  type FactoryIssueCapabilities,
  type FactoryIssueFrontierReadResult,
  type FactoryIssueReadinessReadResult,
  type FactoryReadiness,
  type FactoryReadinessEdge,
  type FactoryReadinessOverride,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  supported: true,
  acceptanceSupported: false,
  deliverySupported: false,
  acceptance: null as unknown,
  deliveries: null as unknown,
  preparedDelivery: null as unknown,
  grant: vi.fn(),
  reconcile: vi.fn(),
  accept: vi.fn(),
  // One entry each time a query goes live or is released, so a read is attributable to an expand
  // and not to a re-render.
  events: [] as string[],
  refresh: vi.fn(),
  result: null as unknown,
  frontier: null as unknown,
  canOperate: true,
  nowMs: Date.parse("2026-10-25T12:00:00.000Z"),
  set: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock(import("../../state/factory"), async () => {
  // The factory runs before this module's static imports are bound, so the atom module is
  // imported here, like `importOriginal` below.
  const { Atom } = await import("effect/reactivity");
  const atoms = new Map<string, { key: string }>();
  // Stable per key, like the real families, so an effect keyed on it does not re-run per render.
  const stable = (key: string) => {
    const existing = atoms.get(key);
    if (existing !== undefined) return existing;
    const created = { key };
    atoms.set(key, created);
    return created;
  };
  const allowed = Atom.make(true);
  const denied = Atom.make(false);
  const permissionAtom = () => (state.canOperate ? allowed : denied);
  const prepareAtoms = {
    "publish-pr": Object.assign(Atom.make(null), { key: "prepare-delivery:publish-pr" }),
    "merge-pr": Object.assign(Atom.make(null), { key: "prepare-delivery:merge-pr" }),
  };
  return {
    factoryEnvironment: {
      readIssueReadiness: ({ input }: { input: { issueNumber: number } }) =>
        stable(String(input.issueNumber)),
      readIssueFrontier: ({ input }: { input: { parentIssueNumber: number } }) =>
        stable(`frontier:${input.parentIssueNumber}`),
      readAcceptance: ({ input }: { input: { projectId: string; threadId: string } }) =>
        stable(`acceptance:${input.projectId}:${input.threadId}`),
      readDeliveries: ({ input }: { input: { projectId: string; threadId: string } }) =>
        stable(`deliveries:${input.projectId}:${input.threadId}`),
      prepareDelivery: ({ input }: { input: { kind: "publish-pr" | "merge-pr" } }) =>
        prepareAtoms[input.kind],
      grantDelivery: { key: "grant", permissionAtom },
      reconcileDelivery: { key: "reconcile", permissionAtom },
      acceptCommit: { key: "accept", permissionAtom },
      setIssueReadinessOverride: { key: "set", permissionAtom },
      revokeIssueReadinessOverride: { key: "revoke", permissionAtom },
    },
    useFactoryReadinessSupported: () => state.supported,
  } as never;
});

vi.mock(import("../../state/presentation"), async () => {
  const { Atom } = await import("effect/reactivity");
  const supported = Atom.make({
    serverConfig: { environment: { capabilities: { factoryAcceptance: true } } },
  });
  const unsupported = Atom.make({
    serverConfig: { environment: { capabilities: {} } },
  });
  const deliverySupported = Atom.make({
    serverConfig: {
      environment: { capabilities: { factoryAcceptance: true, factoryDelivery: true } },
    },
  });
  return {
    environmentPresentations: {
      presentationAtom: () =>
        state.deliverySupported
          ? deliverySupported
          : state.acceptanceSupported
            ? supported
            : unsupported,
    },
  } as never;
});

vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: { key: string }) => (value: unknown) =>
    command.key === "accept"
      ? state.accept(value)
      : command.key === "grant"
        ? state.grant(value)
        : command.key === "reconcile"
          ? state.reconcile(value)
          : command.key === "set"
            ? state.set(value)
            : state.revoke(value)) as never,
}));

vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: ((atom: { key: string } | null) => {
    useEffect(() => {
      if (atom === null) return;
      state.events.push(`observe ${atom.key}`);
      return () => {
        state.events.push(`release ${atom.key}`);
      };
    }, [atom]);
    return {
      data:
        atom === null
          ? null
          : atom.key.startsWith("acceptance:")
            ? state.acceptance
            : atom.key.startsWith("deliveries:")
              ? state.deliveries
              : atom.key.startsWith("prepare-delivery:")
                ? state.preparedDelivery
                : atom.key.startsWith("frontier:")
                  ? state.frontier
                  : state.result,
      dataUpdatedAt: 0,
      error: null,
      failure: null,
      isPending: false,
      isSuccess: true,
      refresh: state.refresh,
    };
  }) as never,
}));

// The clock is fixed so freshness never depends on how fast the browser ran.
vi.mock(import("../../hooks/useNowSecond"), () => ({
  useNowSecond: (() => state.nowMs) as never,
}));

import { act, render } from "../../../test/render";
import { claimConflicts, originKeyForIssue } from "./factoryClaims.logic";
import { FactoryIssueWorkView } from "./FactoryIssueWorkView";
import type { FactoryClaimsView } from "./useFactoryClaims";

const environmentId = EnvironmentId.make("environment:test");
const projectId = ProjectId.make("project:test");
// Fresh against the fixed clock above: an override can only be recorded from a current observation.
const observedAt = new Date(state.nowMs).toISOString();

function issue(number: number, issueState: FactoryIssue["state"]): FactoryIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body of issue ${number}`,
    revision: "a".repeat(64),
    state: issueState,
    url: `https://github.com/owner/repo/issues/${number}`,
    labels: [],
    updatedAt: "2026-10-23T00:00:00.000Z",
    task: null,
  };
}

const repository = {
  provider: SourceControlProviderKind.make("github"),
  host: "github.com",
  repository: "owner/repo",
  canonicalKey: "github.com/owner/repo",
  url: "https://github.com/owner/repo",
} as const;

const capabilities: FactoryIssueCapabilities = {
  provider: repository.provider,
  displayName: "GitHub",
  blockedBy: "listing-with-total",
  subIssues: true,
  closeAcceptance: "close-reason",
  publish: true,
  headPinnedMerge: true,
};

const openEdge: FactoryReadinessEdge = {
  targetId: 9009,
  targetHost: "github.com",
  targetRepository: "owner/repo",
  targetNumber: 9,
  targetUrl: "https://github.com/owner/repo/issues/9",
  title: "Pick a transport",
  state: "open",
  stateReason: null,
  closedAt: null,
  resolution: "open",
  status: "present",
  firstObservedAt: "2026-10-24T00:00:00.000Z",
  lastObservedAt: "2026-10-24T00:00:00.000Z",
  fingerprint: "fingerprint-open",
  override: null,
};

const acceptedEdge: FactoryReadinessEdge = {
  ...openEdge,
  targetId: 4004,
  targetNumber: 4,
  targetUrl: "https://github.com/owner/repo/issues/4",
  title: "Land the schema",
  state: "closed",
  stateReason: "completed",
  closedAt: "2026-10-20T09:00:00.000Z",
  resolution: "accepted",
  fingerprint: "fingerprint-accepted",
};

const deletedEdge: FactoryReadinessEdge = {
  ...openEdge,
  targetId: 5005,
  targetNumber: 5,
  targetUrl: "https://github.com/owner/repo/issues/5",
  title: null,
  state: null,
  resolution: "deleted",
  status: "deleted",
  fingerprint: "fingerprint-deleted",
};

// Fresh by default: an override can only be recorded from a current observation.
function readinessOf(overrides: Partial<FactoryReadiness>): FactoryReadiness {
  return {
    status: "blocked",
    reasons: ["open-blocker"],
    basis: null,
    edges: [openEdge],
    overrides: [],
    complete: true,
    listedCount: (overrides.edges ?? [openEdge]).length,
    summaryTotal: (overrides.edges ?? [openEdge]).length,
    observedAt,
    ...overrides,
  };
}

function resultOf(overrides: Partial<FactoryReadiness>): FactoryIssueReadinessReadResult {
  return { repository, issueNumber: 7, readiness: readinessOf(overrides) };
}

const blockedResult: FactoryIssueReadinessReadResult = {
  repository,
  issueNumber: 7,
  readiness: { ...readinessOf({}), observedAt: "2026-10-24T00:00:00.000Z" },
};

const waiver: FactoryReadinessOverride = {
  id: FactoryReadinessOverrideId.make("override-waive"),
  kind: "waive",
  targetHost: "github.com",
  targetId: 5005,
  boundFingerprint: "fingerprint-deleted",
  reason: "Deleted upstream and retired by hand.",
  createdAt: "2026-10-25T10:00:00.000Z",
  revokedAt: null,
  status: "active",
};

function setup(supported = true) {
  state.supported = supported;
  state.acceptanceSupported = false;
  state.deliverySupported = false;
  state.acceptance = null;
  state.deliveries = null;
  state.preparedDelivery = null;
  state.grant.mockReset();
  state.reconcile.mockReset();
  state.accept.mockReset();
  state.events = [];
  state.result = blockedResult;
  state.frontier = null;
  state.canOperate = true;
  state.refresh.mockClear();
  state.set.mockReset();
  state.revoke.mockReset();
}

const workView = (
  <FactoryIssueWorkView
    environmentId={environmentId}
    mode="list"
    issues={[issue(7, "open"), issue(8, "closed")]}
    canStart
    busy={false}
    startingIssue={null}
    selectedProjectId={projectId}
    projectTitleById={new Map()}
    refreshing={false}
    claims={null}
    repository={repository}
    capabilities={capabilities}
    onStart={vi.fn()}
    onRestart={vi.fn()}
    onResume={vi.fn()}
    onOpen={vi.fn()}
  />
);

it("observes blockers once per expand, only for an open issue", async () => {
  setup();
  await using screen = await render(workView);
  // Listing rows read nothing.
  expect(state.events).toEqual([]);

  await screen.getByRole("button", { name: "Show issue #7 body" }).click();
  await expect.element(screen.getByText("Body of issue 7")).toBeVisible();
  await expect.element(screen.getByText(/^Blocked: 1 unresolved blocker/)).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "owner/repo#9" }))
    .toHaveAttribute("href", "https://github.com/owner/repo/issues/9");
  expect(state.events).toEqual(["observe 7"]);

  // A re-render of the same expansion is not another read.
  await screen.rerender(workView);
  expect(state.events).toEqual(["observe 7"]);

  await screen.getByRole("button", { name: "Hide issue #7 body" }).click();
  await screen.getByRole("button", { name: "Show issue #7 body" }).click();
  expect(state.events).toEqual(["observe 7", "release 7", "observe 7"]);

  // A closed issue has nothing to wait on.
  await screen.getByRole("button", { name: "Show issue #8 body" }).click();
  await expect.element(screen.getByText("Body of issue 8")).toBeVisible();
  expect(state.events).toEqual(["observe 7", "release 7", "observe 7"]);
});

it("asks again only when Refresh is pressed", async () => {
  setup();
  await using screen = await render(workView);
  await screen.getByRole("button", { name: "Show issue #7 body" }).click();
  await screen.getByRole("button", { name: "Refresh blockers for issue #7" }).click();
  expect(state.refresh).toHaveBeenCalledTimes(1);
  expect(state.events).toEqual(["observe 7"]);
});

it("reads nothing from a server that does not advertise readiness", async () => {
  setup(false);
  await using screen = await render(workView);
  await screen.getByRole("button", { name: "Show issue #7 body" }).click();
  await expect.element(screen.getByText("Body of issue 7")).toBeVisible();
  await expect.element(screen.getByText("Blockers", { exact: true })).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: /^(Show|Hide) sub-issues/ }))
    .not.toBeInTheDocument();
  expect(state.events).toEqual([]);
});

const reasonBox = () => page.getByRole("textbox", { name: "Reason" });
const dialog = () => page.getByRole("dialog");
// Pointer actionability trips on the dialog's inert guards, so dialog buttons are pressed through
// the DOM, as the other dialog tests do.
const press = (name: string) =>
  act(async () => {
    const button = page.getByRole("button", { name, exact: true }).element();
    if (!(button instanceof HTMLButtonElement)) throw new Error(`${name} is not a button`);
    button.click();
  });

it("records a dispute on an accepted blocker, bound to the fingerprint that was reviewed", async () => {
  setup();
  state.result = resultOf({ status: "ready", reasons: [], basis: "source", edges: [acceptedEdge] });
  state.set.mockResolvedValue(AsyncResult.success(state.result));
  await using screen = await render(workView);
  await screen.getByRole("button", { name: "Show issue #7 body" }).click();
  // Only an accepted blocker can be disputed, and an open one offers nothing.
  await expect
    .element(screen.getByRole("button", { name: /^Waive blocker/ }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Dispute blocker owner/repo#4" }).click();

  const confirm = page.getByRole("button", { name: "Record dispute" });
  await expect.element(page.getByRole("heading", { name: "Dispute blocker" })).toBeVisible();
  await expect.element(confirm).toBeDisabled();
  await userEvent.fill(reasonBox(), "   ");
  await expect.element(confirm).toBeDisabled();
  await userEvent.fill(reasonBox(), "Closed by a bot, not finished.");
  await expect.element(page.getByText("30 / 1024")).toBeVisible();
  await expect.element(confirm).toBeEnabled();
  await press("Record dispute");

  expect(state.set).toHaveBeenCalledTimes(1);
  expect(state.set).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({
      projectId,
      issueNumber: 7,
      targetHost: "github.com",
      targetId: 4004,
      expectedFingerprint: "fingerprint-accepted",
      kind: "force-not-ready",
      reason: "Closed by a bot, not finished.",
    }),
  });
  await expect.element(dialog()).not.toBeInTheDocument();
});

it("records a waiver on a deleted blocker", async () => {
  setup();
  state.result = resultOf({
    reasons: ["deleted-blocker"],
    edges: [deletedEdge],
  });
  state.set.mockResolvedValue(AsyncResult.success(state.result));
  await using screen = await render(workView);
  await screen.getByRole("button", { name: "Show issue #7 body" }).click();
  await screen.getByRole("button", { name: "Waive blocker owner/repo#5" }).click();
  await userEvent.fill(reasonBox(), "Deleted upstream.");
  await press("Record waiver");
  expect(state.set).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({
      targetId: 5005,
      expectedFingerprint: "fingerprint-deleted",
      kind: "waive",
      reason: "Deleted upstream.",
    }),
  });
});

it("keeps the dialog open with the error and refuses resubmission once the blocker changed", async () => {
  setup();
  state.result = resultOf({ status: "ready", reasons: [], basis: "source", edges: [acceptedEdge] });
  state.set.mockResolvedValue(
    AsyncResult.fail(new FactoryIssueError({ reason: "readiness-changed" })),
  );
  await using screen = await render(workView);
  await screen.getByRole("button", { name: "Show issue #7 body" }).click();
  await screen.getByRole("button", { name: "Dispute blocker owner/repo#4" }).click();
  await userEvent.fill(reasonBox(), "Closed by a bot, not finished.");
  const confirm = page.getByRole("button", { name: "Record dispute" });
  await press("Record dispute");

  await expect.element(page.getByText("Blocker changed", { exact: true })).toBeVisible();
  await expect.element(dialog()).toBeVisible();
  // The reason stays as typed, but the stale review can no longer be confirmed.
  await expect.element(reasonBox()).toHaveValue("Closed by a bot, not finished.");
  await expect.element(confirm).toBeDisabled();
  expect(state.set).toHaveBeenCalledTimes(1);

  await press("Cancel");
  await expect.element(dialog()).not.toBeInTheDocument();
  expect(state.set).toHaveBeenCalledTimes(1);
});

it("shows an override in effect and revokes it by id", async () => {
  setup();
  state.result = resultOf({
    status: "ready",
    reasons: [],
    basis: "override",
    edges: [{ ...deletedEdge, override: waiver.id }],
    overrides: [
      waiver,
      {
        ...waiver,
        id: FactoryReadinessOverrideId.make("override-old"),
        status: "revoked",
        revokedAt: "2026-10-25T11:00:00.000Z",
      },
      {
        ...waiver,
        id: FactoryReadinessOverrideId.make("override-lapsed"),
        status: "lapsed",
      },
    ],
  });
  state.revoke.mockResolvedValue(AsyncResult.success(state.result));
  await using screen = await render(workView);
  await screen.getByRole("button", { name: "Show issue #7 body" }).click();
  await expect.element(screen.getByText(/basis: override \(1 waived\)/)).toBeVisible();
  await expect
    .element(screen.getByText("Waived: Deleted upstream and retired by hand."))
    .toBeVisible();
  await expect.element(screen.getByText("Past overrides")).toBeVisible();
  await expect.element(screen.getByText("Revoked", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("No longer applies", { exact: true })).toBeVisible();
  // Nothing new to record on an edge that already carries an override.
  await expect
    .element(screen.getByRole("button", { name: /^Waive blocker/ }))
    .not.toBeInTheDocument();

  await screen.getByRole("button", { name: "Revoke override on blocker owner/repo#5" }).click();
  expect(state.revoke).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ projectId, issueNumber: 7, overrideId: waiver.id }),
  });
});

it("cannot record a decision without operate permission", async () => {
  setup();
  state.result = resultOf({ status: "ready", reasons: [], basis: "source", edges: [acceptedEdge] });
  state.canOperate = false;
  await using screen = await render(workView);
  await screen.getByRole("button", { name: "Show issue #7 body" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Dispute blocker owner/repo#4" }))
    .toBeDisabled();
  await expect
    .element(screen.getByText(/needs operate permission on this environment/))
    .toBeVisible();
});

it("cannot record a decision from a stale observation", async () => {
  setup();
  state.result = resultOf({
    status: "ready",
    reasons: [],
    basis: "source",
    edges: [acceptedEdge],
    observedAt: "2026-10-24T00:00:00.000Z",
  });
  await using screen = await render(workView);
  await screen.getByRole("button", { name: "Show issue #7 body" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Dispute blocker owner/repo#4" }))
    .toBeDisabled();
  await expect
    .element(screen.getByText("This observation is stale. Refresh before changing overrides."))
    .toBeVisible();
});

function frontierOf(
  overrides: Partial<FactoryIssueFrontierReadResult>,
): FactoryIssueFrontierReadResult {
  const child = (number: number) => ({
    number,
    title: `Child ${number}`,
    state: "open" as const,
    url: `https://github.com/owner/repo/issues/${number}`,
    assignees: [],
    readiness: readinessOf({}),
  });
  return {
    repository,
    parentIssueNumber: 7,
    parentTitle: "Map",
    complete: true,
    summaryTotal: 3,
    children: [
      child(9),
      { ...child(3), state: "closed" as const, readiness: null },
      { ...child(5), assignees: ["alice"], readiness: null },
    ],
    observedAt,
    ...overrides,
  };
}

it("reads sub-issues only once opened, lists them in source order, and refreshes on request", async () => {
  setup();
  state.frontier = frontierOf({});
  await using screen = await render(workView);
  await screen.getByRole("button", { name: "Show issue #7 body" }).click();
  // Collapsed by default: opening Details reads blockers but not the frontier.
  expect(state.events).toEqual(["observe 7"]);
  await expect
    .element(screen.getByRole("button", { name: "Show sub-issues of issue #7" }))
    .toHaveAttribute("aria-expanded", "false");

  await screen.getByRole("button", { name: "Show sub-issues of issue #7" }).click();
  expect(state.events).toEqual(["observe 7", "observe frontier:7"]);
  const table = screen.getByRole("table", { name: "Sub-issues of issue #7, in GitHub's order" });
  await expect.element(table).toBeVisible();
  expect(
    table
      .getByRole("link")
      .elements()
      .map((link) => link.textContent),
  ).toEqual(["#9", "#3", "#5"]);
  await expect.element(table.getByText("Closed", { exact: true })).toBeVisible();
  await expect.element(table.getByText("Not observed", { exact: true })).toBeVisible();
  await expect.element(table.getByText("alice", { exact: true })).toBeVisible();
  await expect.element(table.getByText(/^Blocked: 1 unresolved blocker/)).toBeVisible();
  // Read-only: the list itself offers no start, batch or next-issue control.
  await expect.element(table.getByRole("button")).not.toBeInTheDocument();

  state.refresh.mockClear();
  await screen.getByRole("button", { name: "Refresh sub-issues for issue #7" }).click();
  expect(state.refresh).toHaveBeenCalledTimes(1);
  expect(state.events).toEqual(["observe 7", "observe frontier:7"]);

  await screen.getByRole("button", { name: "Hide sub-issues of issue #7" }).click();
  expect(state.events).toEqual(["observe 7", "observe frontier:7", "release frontier:7"]);
});

it("says so when the sub-issue list is incomplete", async () => {
  setup();
  state.frontier = frontierOf({ complete: false, summaryTotal: 17 });
  await using screen = await render(workView);
  await screen.getByRole("button", { name: "Show issue #7 body" }).click();
  await screen.getByRole("button", { name: "Show sub-issues of issue #7" }).click();
  await expect
    .element(
      screen.getByText(
        "Incomplete: GitHub reports 17 sub-issues, 3 listed here. This list may be missing some.",
      ),
    )
    .toBeVisible();
});

it("says an issue without sub-issues has none", async () => {
  setup();
  state.frontier = frontierOf({ children: [], summaryTotal: 0 });
  await using screen = await render(workView);
  await screen.getByRole("button", { name: "Show issue #7 body" }).click();
  await screen.getByRole("button", { name: "Show sub-issues of issue #7" }).click();
  await expect.element(screen.getByText("This issue has no sub-issues.")).toBeVisible();
});

const otherEnvironmentId = EnvironmentId.make("environment:other");

function claimsViewOf(
  mine: { readonly threadId: string; readonly admittedBy: EnvironmentId | null },
  elsewhere: string | null,
): FactoryClaimsView {
  const claim = (
    environment: EnvironmentId,
    threadId: string,
    admittedBy: EnvironmentId | null,
  ) => ({
    environmentId: environment,
    repository,
    fetchedAt: observedAt,
    claims: [
      {
        originKey: originKeyForIssue(repository.provider, repository.canonicalKey, 7),
        origin: "github-issue" as const,
        projectId,
        workspaceRoot: "/work/repo",
        threadId: ThreadId.make(threadId),
        status: "running" as const,
        baseRef: "main",
        createdAt: observedAt,
        creationSource: "web" as const,
        admittedBy,
        originConflict: false,
        acceptance: null,
        artifactAcceptance: null,
      },
    ],
  });
  const claimsByEnvironment = new Map([
    [environmentId, claim(environmentId, mine.threadId, mine.admittedBy)],
    ...(elsewhere === null
      ? []
      : [[otherEnvironmentId, claim(otherEnvironmentId, elsewhere, otherEnvironmentId)] as const]),
  ]);
  return {
    claimsByEnvironment,
    conflicts: claimConflicts(claimsByEnvironment),
    unavailableNote: null,
    labelOf: (id) => (id === environmentId ? "Laptop" : "Dev box"),
    refresh: vi.fn(),
  };
}

const taskOf = (threadId: string): NonNullable<FactoryIssue["task"]> => ({
  projectId,
  threadId: ThreadId.make(threadId),
  status: "running",
  baseRef: "main",
  createdAt: observedAt,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "approval-required",
  interactionMode: "default",
});

const claimedView = (claims: FactoryClaimsView | null) => (
  <FactoryIssueWorkView
    environmentId={environmentId}
    mode="list"
    issues={[{ ...issue(7, "open"), task: taskOf("thread:one") }]}
    canStart
    busy={false}
    startingIssue={null}
    selectedProjectId={projectId}
    projectTitleById={new Map()}
    refreshing={false}
    claims={claims}
    repository={repository}
    capabilities={capabilities}
    onStart={vi.fn()}
    onRestart={vi.fn()}
    onResume={vi.fn()}
    onOpen={vi.fn()}
  />
);

it("flags an origin claimed in two environments and says who admitted this claim", async () => {
  setup();
  await using screen = await render(
    claimedView(
      claimsViewOf({ threadId: "thread:one", admittedBy: otherEnvironmentId }, "thread:two"),
    ),
  );
  await expect.element(screen.getByText("Claimed in 2 environments")).toBeVisible();
  await expect.element(screen.getByText(/each started their own thread/)).toBeVisible();
  await expect.element(screen.getByText(/^Admitted by another environment/)).toBeVisible();
});

it("calls the same thread in two environments a copied database", async () => {
  setup();
  await using screen = await render(
    claimedView(claimsViewOf({ threadId: "thread:one", admittedBy: environmentId }, "thread:one")),
  );
  await expect.element(screen.getByText(/looks like a copied database/)).toBeVisible();
  await expect.element(screen.getByText("Admitted by this environment.")).toBeVisible();
});

it("shows unknown provenance for a claim recorded before provenance existed", async () => {
  setup();
  await using screen = await render(
    claimedView(claimsViewOf({ threadId: "thread:one", admittedBy: null }, null)),
  );
  await expect.element(screen.getByText(/^Provenance unknown/)).toBeVisible();
  await expect.element(screen.getByText(/Claimed in \d+ environments/)).not.toBeInTheDocument();
});

it("shows no claim UI when the environment does not advertise claims", async () => {
  setup();
  await using screen = await render(claimedView(null));
  await expect.element(screen.getByText(/^Admitted by/)).not.toBeInTheDocument();
  await expect.element(screen.getByText(/Claimed in \d+ environments/)).not.toBeInTheDocument();
});

it("warns when the head moved and re-accepts the last observed head", async () => {
  setup();
  state.acceptanceSupported = true;
  const liveHeadSha = "b".repeat(40);
  state.acceptance = {
    acceptance: {
      id: "acceptance:one",
      originKey: originKeyForIssue(repository.provider, repository.canonicalKey, 7),
      projectId,
      threadId: ThreadId.make("thread:one"),
      headSha: "a".repeat(40),
      baseRef: "main",
      baseSha: "c".repeat(40),
      acceptedAt: observedAt,
      acceptedBy: environmentId,
      evidenceRefs: ["https://example.test/review"],
    },
    liveHeadSha,
    current: false,
  };
  state.accept.mockResolvedValue(AsyncResult.success(undefined));
  await using screen = await render(
    claimedView(claimsViewOf({ threadId: "thread:one", admittedBy: environmentId }, null)),
  );
  await expect.element(screen.getByText("Head moved since acceptance")).toBeVisible();
  await expect.element(screen.getByText("aaaaaaa")).toBeVisible();
  await expect.element(screen.getByText("bbbbbbb")).toBeVisible();
  const reaccept = screen.getByRole("button", { name: "Re-accept at current head" });
  await expect.element(reaccept).toBeEnabled();
  await reaccept.click();
  await vi.waitFor(() => {
    expect(state.accept).toHaveBeenCalledWith({
      environmentId,
      input: {
        projectId,
        threadId: ThreadId.make("thread:one"),
        expectedHeadSha: liveHeadSha,
        evidenceRefs: [],
        supersede: true,
      },
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
});

it("reconciles an unknown publication without granting another delivery", async () => {
  setup();
  state.deliverySupported = true;
  const headSha = "a".repeat(40);
  const acceptance = {
    id: "acceptance:one",
    originKey: originKeyForIssue(repository.provider, repository.canonicalKey, 7),
    projectId,
    threadId: ThreadId.make("thread:one"),
    headSha,
    baseRef: "main",
    baseSha: "c".repeat(40),
    acceptedAt: observedAt,
    acceptedBy: environmentId,
    evidenceRefs: [],
  };
  const intent: FactoryDeliveryIntent = {
    id: "delivery:one",
    originKey: acceptance.originKey,
    threadId: acceptance.threadId,
    projectId,
    kind: "publish-pr",
    acceptanceId: acceptance.id,
    repository,
    baseRef: acceptance.baseRef,
    baseSha: acceptance.baseSha,
    headSha,
    payload: {
      title: "Publish accepted change",
      body: "Issue: https://github.com/owner/repo/issues/7",
      draft: true,
    },
    payloadDigest: "d".repeat(64),
    grantedBy: environmentId,
    grantedAt: observedAt,
    requestCommandId: "command:publish",
    status: "unknown",
    remote: null,
    failure: "response lost",
    updatedAt: observedAt,
  };
  state.acceptance = { acceptance, liveHeadSha: headSha, current: true };
  state.deliveries = { intents: [intent] };
  state.reconcile.mockImplementation(async () => {
    const confirmed: FactoryDeliveryIntent = {
      ...intent,
      status: "confirmed",
      remote: { number: 123, url: "https://github.com/owner/repo/pull/123" },
      failure: null,
    };
    state.deliveries = { intents: [confirmed] };
    return AsyncResult.success(confirmed);
  });
  await using screen = await render(claimedView(null));
  await expect
    .element(screen.getByText("The server lost the response. Reconcile to check GitHub."))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Grant publish" })).toBeDisabled();
  const reconcile = screen.getByRole("button", { name: "Reconcile", exact: true });
  await expect.element(reconcile).toBeEnabled();
  await reconcile.click();
  await vi.waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(1));
  await screen.rerender(claimedView(null));
  await expect
    .element(screen.getByRole("link", { name: "#123", exact: true }))
    .toHaveAttribute("href", "https://github.com/owner/repo/pull/123");
  await expect.element(reconcile).not.toBeInTheDocument();
  expect(state.reconcile).toHaveBeenCalledWith({
    environmentId,
    input: { projectId, intentId: intent.id },
  });
  expect(state.grant).not.toHaveBeenCalled();
});

it("disables the merge grant when the published PR head is not the accepted commit", async () => {
  setup();
  state.deliverySupported = true;
  const headSha = "a".repeat(40);
  const acceptance = {
    id: "acceptance:one",
    originKey: originKeyForIssue(repository.provider, repository.canonicalKey, 7),
    projectId,
    threadId: ThreadId.make("thread:one"),
    headSha,
    baseRef: "main",
    baseSha: "c".repeat(40),
    acceptedAt: observedAt,
    acceptedBy: environmentId,
    evidenceRefs: [],
  };
  const remote = { number: 123, url: "https://github.com/owner/repo/pull/123" };
  const published: FactoryDeliveryIntent = {
    id: "delivery:published",
    originKey: acceptance.originKey,
    threadId: acceptance.threadId,
    projectId,
    kind: "publish-pr",
    acceptanceId: acceptance.id,
    repository,
    baseRef: acceptance.baseRef,
    baseSha: acceptance.baseSha,
    headSha,
    payload: { title: "Publish accepted change", body: "Fixes #7", draft: false },
    payloadDigest: "d".repeat(64),
    grantedBy: environmentId,
    grantedAt: observedAt,
    requestCommandId: "command:publish",
    status: "confirmed",
    remote,
    failure: null,
    updatedAt: observedAt,
  };
  state.acceptance = { acceptance, liveHeadSha: headSha, current: true };
  state.deliveries = { intents: [published] };
  state.preparedDelivery = {
    acceptance,
    current: true,
    repository,
    baseRef: acceptance.baseRef,
    headSha,
    payload: { mergeMethod: "squash" },
    payloadDigest: "e".repeat(64),
    existing: null,
    pullRequest: {
      ...remote,
      headSha: "b".repeat(40),
      state: "open",
      mergeability: "mergeable",
      isDraft: false,
      checksSummary: "3 passed",
      mergeMethods: ["merge", "squash", "rebase"],
    },
  } satisfies FactoryDeliveryPrepareResult;

  await using screen = await render(claimedView(null));
  const merge = screen.getByRole("region", { name: "Merge", exact: true });
  await expect.element(merge).toBeVisible();
  await merge.getByRole("button", { name: "Prepare merge" }).click();
  await expect
    .element(merge.getByRole("link", { name: "#123", exact: true }))
    .toHaveAttribute("href", remote.url);
  await expect.element(merge.getByText("Does not match the accepted commit.")).toBeVisible();
  await expect.element(merge.getByText("3 passed")).toBeVisible();
  await expect.element(merge.getByRole("button", { name: "Grant merge" })).toBeDisabled();
  await expect
    .element(
      merge.getByText("The pull request head is not the accepted commit. Re-accept and refresh."),
    )
    .toBeVisible();
  expect(state.grant).not.toHaveBeenCalled();
});
