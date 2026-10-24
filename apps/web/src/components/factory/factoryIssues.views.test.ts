import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryIssue,
  type FactoryIssueTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupFactoryIssuesByStage, parseFactoryIssueViewMode } from "./factoryIssues.views";

function issue(
  number: number,
  status: FactoryIssueTask["status"] | null,
  state: FactoryIssue["state"] = "open",
  labels: ReadonlyArray<string> = [],
): FactoryIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: null,
    revision: "a".repeat(64),
    state,
    url: `https://github.com/o/r/issues/${number}`,
    labels,
    updatedAt: "2026-10-23T00:00:00.000Z",
    task:
      status === null
        ? null
        : {
            projectId: ProjectId.make("project-1"),
            threadId: ThreadId.make(`thread-${number}`),
            status,
            baseRef: "abc123",
            createdAt: "2026-10-23T00:00:00.000Z",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.1-codex",
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
  };
}

describe("parseFactoryIssueViewMode", () => {
  it.each([
    ["table", "table"],
    ["board", "board"],
  ])("selects the exact %s route mode", (value, expected) => {
    expect(parseFactoryIssueViewMode(value)).toBe(expected);
  });

  it.each(
    [undefined, "kanban", ["table"], { toString: () => "board" }].map((value) => ({ value })),
  )("falls back to List for an unknown or non-string route value: %j", ({ value }) => {
    expect(parseFactoryIssueViewMode(value)).toBe("list");
  });
});

describe("groupFactoryIssuesByStage", () => {
  it("keeps closed running work in Running and closed unlinked issues in No task", () => {
    const running = issue(21, "running", "closed");
    const unlinked = issue(22, null, "closed");
    const groups = groupFactoryIssuesByStage([running, unlinked]);

    expect(
      groups
        .filter((group) => group.issues.length > 0)
        .map((group) => ({
          stage: group.stage,
          numbers: group.issues.map((item) => item.number),
        })),
    ).toEqual([
      { stage: "none", numbers: [22] },
      { stage: "running", numbers: [21] },
    ]);
  });

  it("keeps every task status distinct in canonical order, independent of input order", () => {
    const missing = issue(8, "missing", "closed");
    const archived = issue(7, "archived");
    const failed = issue(6, "failed");
    const idle = issue(5, "idle");
    const running = issue(4, "running");
    const preparing = issue(3, "preparing");
    const launching = issue(2, "launching", "closed");
    const unlinked = issue(1, null);
    const groups = groupFactoryIssuesByStage([
      missing,
      archived,
      failed,
      idle,
      running,
      preparing,
      launching,
      unlinked,
    ]);

    expect(groups).toEqual([
      { stage: "none", issues: [unlinked] },
      { stage: "launching", issues: [launching] },
      { stage: "preparing", issues: [preparing] },
      { stage: "running", issues: [running] },
      { stage: "idle", issues: [idle] },
      { stage: "failed", issues: [failed] },
      { stage: "archived", issues: [archived] },
      { stage: "missing", issues: [missing] },
    ]);
  });

  it("preserves page order within stages without using labels", () => {
    const firstRunning = issue(90, "running", "open", ["done", "blocked"]);
    const firstUnlinked = issue(70, null, "open", ["running", "ready"]);
    const secondRunning = issue(10, "running", "closed", ["archived"]);
    const secondUnlinked = issue(2, null, "closed", ["launching", "failed"]);
    const page = Object.freeze([firstRunning, firstUnlinked, secondRunning, secondUnlinked]);
    const groups = groupFactoryIssuesByStage(page);
    const running = groups.find((group) => group.stage === "running")?.issues;
    const unlinked = groups.find((group) => group.stage === "none")?.issues;

    expect(running?.map((item) => item.number)).toEqual([90, 10]);
    expect(unlinked?.map((item) => item.number)).toEqual([70, 2]);
  });
});
