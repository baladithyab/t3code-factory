import { assert, it } from "@effect/vitest";
import { VcsProcessExitError, VcsProcessOutputLimitError } from "@t3tools/contracts";
import type { SourceControlProcessOutput } from "@t3tools/source-control-core/server/SourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Provider from "./GitLabIssueTrackerProvider.ts";
import * as GitLabCli from "./GitLabCli.ts";

const repository = {
  cwd: "/repo",
  host: "gitlab.example.com",
  repository: "group/subgroup/project",
};
const issue = {
  id: 98765,
  iid: 12,
  issue_type: "issue",
  title: "Task",
  description: null,
  state: "opened",
  web_url: "https://gitlab.example.com/group/subgroup/project/-/issues/12",
  labels: ["bug"],
  updated_at: "2026-10-23T00:00:00Z",
};
const response = (
  body: unknown,
  header = "X-Next-Page: ",
  overrides: Partial<SourceControlProcessOutput> = {},
) =>
  Effect.succeed({
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n${header}\r\n\r\n${JSON.stringify(body)}`,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  });
const make = (execute: GitLabCli.GitLabCli["Service"]["execute"]) =>
  Provider.make.pipe(Effect.provide(Layer.mock(GitLabCli.GitLabCli)({ execute })));

it.effect("maps iid and opened state, filters non-issues, and encodes the nested path", () =>
  Effect.gen(function* () {
    const requests: Array<Parameters<GitLabCli.GitLabCli["Service"]["execute"]>[0]> = [];
    const tracker = yield* make((input) => {
      requests.push(input);
      return response([issue, { ...issue, iid: 13, issue_type: "incident" }], "X-Next-Page: 4");
    });
    const page = yield* tracker.listIssues({ ...repository, state: "open", page: 2 });
    assert.deepEqual(page, {
      issues: [
        {
          number: 12,
          title: "Task",
          body: null,
          state: "open",
          url: issue.web_url,
          labels: ["bug"],
          updatedAt: "2026-10-23T00:00:00.000Z",
        },
      ],
      nextPage: 4,
    });
    assert.deepEqual(requests[0]?.args, [
      "api",
      "--hostname",
      "gitlab.example.com",
      "--include",
      "projects/group%2Fsubgroup%2Fproject/issues?state=opened&issue_type=issue&per_page=30&page=2&order_by=updated_at&sort=desc",
    ]);
    assert.equal(requests[0]?.cwd, "/repo");
    assert.deepEqual(tracker.capabilities, {
      displayName: "GitLab",
      blockedBy: "none",
      subIssues: false,
      closeAcceptance: "none",
      publish: false,
      headPinnedMerge: false,
    });
  }),
);

it.effect.each(["gitlab.example.com", "gitlab.example.com:8443"])(
  "routes issue requests for %s through the checkout",
  (host) =>
    Effect.gen(function* () {
      const requests: Array<Parameters<GitLabCli.GitLabCli["Service"]["execute"]>[0]> = [];
      const tracker = yield* make((input) => {
        requests.push(input);
        return response(input.args.at(-1)?.endsWith("/12") ? issue : [issue]);
      });
      yield* tracker.listIssues({ ...repository, host, state: "open", page: 1 });
      yield* tracker.getIssue({ ...repository, host, number: 12 });
      assert.equal(requests.length, 2);
      for (const request of requests) {
        assert.equal(request.cwd, repository.cwd);
        assert.deepEqual(
          request.args.slice(0, -1),
          host === "gitlab.example.com"
            ? ["api", "--hostname", "gitlab.example.com", "--include"]
            : ["api", "--include"],
        );
      }
    }),
);

it.effect.each(["closed", "all"] as const)("passes %s state and decodes a final page", (state) =>
  Effect.gen(function* () {
    const tracker = yield* make(({ args }) => {
      assert.include(args.at(-1) ?? "", `state=${state}&`);
      return response([{ ...issue, state: "closed" }]);
    });
    const result = yield* tracker.listIssues({ ...repository, state, page: 1 });
    assert.equal(result.issues[0]?.state, "closed");
    assert.isNull(result.nextPage);
  }),
);

it.effect.each(["x-next-page: 2", "X-NeXt-PaGe: 2"])(
  "matches pagination headers case-insensitively: %s",
  (header) =>
    Effect.gen(function* () {
      const tracker = yield* make(() => response([{ ...issue, issue_type: "task" }], header));
      assert.deepEqual(yield* tracker.listIssues({ ...repository, state: "open", page: 1 }), {
        issues: [],
        nextPage: 2,
      });
    }),
);

it.effect("accepts LF-delimited headers and reads a project-local iid", () =>
  Effect.gen(function* () {
    const tracker = yield* make(({ args }) => {
      assert.equal(args.at(-1), "projects/group%2Fsubgroup%2Fproject/issues/12");
      return response(issue, "", {
        stdout: `HTTP/2.0 200 OK\nContent-Type: application/json\n\n${JSON.stringify(issue)}`,
      });
    });
    const result = yield* tracker.getIssue({ ...repository, number: 12 });
    assert.equal(result.number, 12);
    assert.equal(result.state, "open");
  }),
);

it.effect.each([
  { raw: { ...issue, iid: 13 }, reason: "invalid-response" },
  { raw: { ...issue, issue_type: "incident" }, reason: "not-an-issue" },
  { raw: { ...issue, updated_at: "invalid" }, reason: "invalid-response" },
])("rejects detail response with $reason", ({ raw, reason }) =>
  Effect.gen(function* () {
    const tracker = yield* make(() => response(raw));
    assert.equal(
      (yield* tracker.getIssue({ ...repository, number: 12 }).pipe(Effect.flip)).reason,
      reason,
    );
  }),
);

it.effect.each([
  { override: { stdoutTruncated: true }, reason: "truncated-response" },
  { override: { stderrTruncated: true }, reason: "truncated-response" },
  { override: { stdoutInvalidUtf8: true }, reason: "invalid-response" },
  { override: { stdout: "HTTP/2.0 200 OK\n\n{" }, reason: "invalid-response" },
  { override: { stdout: "[]" }, reason: "invalid-response" },
])("rejects incomplete or invalid CLI output as $reason", ({ override, reason }) =>
  Effect.gen(function* () {
    const tracker = yield* make(() => response([], "", override));
    assert.equal(
      (yield* tracker.listIssues({ ...repository, state: "open", page: 1 }).pipe(Effect.flip))
        .reason,
      reason,
    );
  }),
);

it.effect.each(["garbage", "0", "1", "2.5", "9007199254740992"])(
  "rejects invalid next-page header %s",
  (value) =>
    Effect.gen(function* () {
      const tracker = yield* make(() => response([], `X-Next-Page: ${value}`));
      assert.equal(
        (yield* tracker.listIssues({ ...repository, state: "open", page: 1 }).pipe(Effect.flip))
          .reason,
        "invalid-response",
      );
    }),
);

const context = { operation: "execute", command: "glab", cwd: "/repo", cause: "test" } as const;
it.effect.each([
  { error: new GitLabCli.GitLabCliUnavailableError(context), reason: "missing-tool" },
  { error: new GitLabCli.GitLabCliAuthenticationError(context), reason: "unauthenticated" },
  { error: new GitLabCli.GitLabCliRateLimitError(context), reason: "rate-limited" },
  {
    error: GitLabCli.GitLabCliCommandError.fromVcsError(
      context,
      VcsProcessExitError.fromProcessExit(
        context,
        { exitCode: 1, stderr: "glab: 404 Not Found (HTTP 404)", stderrTruncated: false },
        "not-found",
      ),
    ),
    reason: "not-found",
  },
  { error: new GitLabCli.GitLabCliCommandError(context), reason: "failed" },
  {
    error: new GitLabCli.GitLabCliCommandError({
      ...context,
      cause: new VcsProcessOutputLimitError({
        ...context,
        stream: "stdout",
        maxBytes: 8,
        observedBytes: 9,
      }),
    }),
    reason: "truncated-response",
  },
])("maps CLI errors to $reason", ({ error, reason }) =>
  Effect.gen(function* () {
    const tracker = yield* make(() => Effect.fail(error));
    const failure = yield* tracker
      .listIssues({ ...repository, state: "open", page: 1 })
      .pipe(Effect.flip);
    assert.equal(failure.reason, reason);
    assert.equal(failure.cause, error);
  }),
);

it.effect("accepts nested namespaces but rejects empty and traversal segments", () =>
  Effect.gen(function* () {
    const tracker = yield* make(() => Effect.die("Path validation must not call GitLab"));
    for (const path of ["group/project", "group/subgroup/project"])
      assert.equal(tracker.repositoryPath(path), path);
    for (const path of [
      "project",
      "group//project",
      "group/project/",
      "group/../project",
      "group/./project",
      "group/project?x=1",
    ])
      assert.isNull(tracker.repositoryPath(path));
  }),
);
