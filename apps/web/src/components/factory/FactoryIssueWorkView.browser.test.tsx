import {
  EnvironmentId,
  ProjectId,
  type FactoryIssue,
  type FactoryIssueReadinessReadResult,
} from "@t3tools/contracts";
import { useEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  supported: true,
  // One entry each time a readiness query goes live or is released, so a read is attributable to
  // an expand and not to a re-render.
  events: [] as string[],
  refresh: vi.fn(),
  result: null as unknown,
}));

vi.mock(import("../../state/factory"), () => {
  const atoms = new Map<number, { key: string }>();
  return {
    factoryEnvironment: {
      // Stable per issue, like the real family, so an effect keyed on it does not re-run per render.
      readIssueReadiness: ({ input }: { input: { issueNumber: number } }) => {
        const existing = atoms.get(input.issueNumber);
        if (existing !== undefined) return existing;
        const created = { key: String(input.issueNumber) };
        atoms.set(input.issueNumber, created);
        return created;
      },
    },
    useFactoryReadinessSupported: () => state.supported,
  } as never;
});

vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: ((atom: { key: string }) => {
    useEffect(() => {
      state.events.push(`observe ${atom.key}`);
      return () => {
        state.events.push(`release ${atom.key}`);
      };
    }, [atom]);
    return {
      data: state.result,
      dataUpdatedAt: 0,
      error: null,
      failure: null,
      isPending: false,
      isSuccess: true,
      refresh: state.refresh,
    };
  }) as never,
}));

import { render } from "../../../test/render";
import { FactoryIssueWorkView } from "./FactoryIssueWorkView";

const environmentId = EnvironmentId.make("environment:test");
const projectId = ProjectId.make("project:test");

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

const blockedResult: FactoryIssueReadinessReadResult = {
  repository: {
    provider: "github",
    host: "github.com",
    repository: "owner/repo",
    canonicalKey: "github.com/owner/repo",
    url: "https://github.com/owner/repo",
  },
  issueNumber: 7,
  readiness: {
    status: "blocked",
    reasons: ["open-blocker"],
    edges: [
      {
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
      },
    ],
    complete: true,
    listedCount: 1,
    summaryTotal: 1,
    observedAt: "2026-10-24T00:00:00.000Z",
  },
};

function setup(supported = true) {
  state.supported = supported;
  state.events = [];
  state.result = blockedResult;
  state.refresh.mockClear();
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
  expect(state.events).toEqual([]);
});
