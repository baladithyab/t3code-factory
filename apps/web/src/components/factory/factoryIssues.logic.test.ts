import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  FactoryIssueError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryIssue,
  type FactoryIssueTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boundedIssueBody,
  currentFactoryPage,
  describeFactoryFailure,
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
