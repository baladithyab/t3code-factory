import { assert, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { SourceControlRateLimitPausedError } from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Provider from "./GitHubIssueTrackerProvider.ts";
import * as GitHubRest from "./GitHubRest.ts";
import { GitHubNotSignedInError } from "./GitHubCredentials.ts";
import {
  GitHubApiAuthenticationError,
  GitHubApiNotFoundError,
  GitHubApiRateLimitError,
  GitHubApiRequestError,
  GitHubApiResponseError,
} from "./GitHubRequestPolicy.ts";

const repository = { cwd: "/repo", host: "github.com", repository: "owner/project" };
const issue = {
  number: 12,
  title: "Task",
  body: null,
  state: "open",
  html_url: "https://github.com/owner/project/issues/12",
  labels: ["bug", { name: "triaged" }],
  updated_at: "2026-10-23T00:00:00Z",
};
const response = (body: unknown, overrides: Partial<GitHubRest.GitHubRestResponse> = {}) =>
  Effect.succeed({
    status: 200,
    headers: {},
    body: JSON.stringify(body),
    truncated: false,
    invalidUtf8: false,
    ...overrides,
  });
const make = (rest: GitHubRest.GitHubRest["Service"]["rest"]) =>
  Provider.make.pipe(Effect.provide(Layer.mock(GitHubRest.GitHubRest)({ rest })));

it.effect("normalizes issues and filters PRs while retaining Link pagination", () =>
  Effect.gen(function* () {
    const requests: GitHubRest.GitHubRestInput[] = [];
    const tracker = yield* make((input) => {
      requests.push(input);
      return response([issue, { ...issue, number: 13, pull_request: {} }], {
        headers: {
          link: '<https://api.github.com/issues?page=1>; rel="prev", <https://api.github.com/issues?page=3>; rel="next"',
        },
      });
    });
    const page = yield* tracker.listIssues({ ...repository, state: "all", page: 2 });
    assert.deepEqual(page, {
      issues: [
        {
          number: 12,
          title: "Task",
          body: null,
          state: "open",
          url: issue.html_url,
          labels: ["bug", "triaged"],
          updatedAt: "2026-10-23T00:00:00.000Z",
        },
      ],
      nextPage: 3,
    });
    assert.equal(
      requests[0]?.path,
      "repos/owner/project/issues?state=all&per_page=30&page=2&sort=updated&direction=desc",
    );
    assert.equal(requests[0]?.host, "github.com");
    assert.deepEqual(tracker.capabilities, {
      displayName: "GitHub",
      blockedBy: "listing-with-total",
      subIssues: true,
      closeAcceptance: "close-reason",
      publish: true,
      headPinnedMerge: true,
    });
  }),
);

it.effect("passes an enterprise authority with its port unchanged to GitHubRest", () =>
  Effect.gen(function* () {
    const requests: GitHubRest.GitHubRestInput[] = [];
    const tracker = yield* make((input) => {
      requests.push(input);
      return response(input.path.endsWith("/12") ? issue : [issue]);
    });
    const host = "code.example:8443";
    yield* tracker.listIssues({ ...repository, host, state: "open", page: 1 });
    yield* tracker.getIssue({ ...repository, host, number: 12 });
    assert.deepEqual(
      requests.map((request) => request.host),
      [host, host],
    );
  }),
);

it.effect("an all-PR page still advances and a final page has no continuation", () =>
  Effect.gen(function* () {
    const tracker = yield* make(() =>
      response([{ ...issue, pull_request: {} }], {
        headers: { link: '<https://api.github.com/issues?page=2>; rel="next"' },
      }),
    );
    assert.deepEqual(yield* tracker.listIssues({ ...repository, state: "open", page: 1 }), {
      issues: [],
      nextPage: 2,
    });
    const final = yield* make(() => response([]));
    assert.deepEqual(yield* final.listIssues({ ...repository, state: "closed", page: 2 }), {
      issues: [],
      nextPage: null,
    });
  }),
);

it.effect("reads an issue by its project-local number", () =>
  Effect.gen(function* () {
    const tracker = yield* make((input) => {
      assert.equal(input.path, "repos/owner/project/issues/12");
      return response(issue);
    });
    const result = yield* tracker.getIssue({ ...repository, number: 12 });
    assert.equal(result.number, 12);
    assert.equal(result.updatedAt, "2026-10-23T00:00:00.000Z");
  }),
);

it.effect.each([
  { raw: { ...issue, pull_request: {} }, reason: "not-an-issue" },
  { raw: { ...issue, number: 13 }, reason: "invalid-response" },
  { raw: { ...issue, updated_at: "not-a-timestamp" }, reason: "invalid-response" },
])("rejects $reason on detail reads", ({ raw, reason }) =>
  Effect.gen(function* () {
    const tracker = yield* make(() => response(raw));
    assert.equal(
      (yield* tracker.getIssue({ ...repository, number: 12 }).pipe(Effect.flip)).reason,
      reason,
    );
  }),
);

it.effect.each([
  { override: { truncated: true }, reason: "truncated-response" },
  { override: { invalidUtf8: true }, reason: "invalid-response" },
  { override: { body: "{" }, reason: "invalid-response" },
  {
    override: { body: JSON.stringify([{ ...issue, updated_at: "bad" }]) },
    reason: "invalid-response",
  },
])("rejects an incomplete or invalid list response as $reason", ({ override, reason }) =>
  Effect.gen(function* () {
    const tracker = yield* make(() => response([], override));
    assert.equal(
      (yield* tracker.listIssues({ ...repository, state: "open", page: 1 }).pipe(Effect.flip))
        .reason,
      reason,
    );
  }),
);

const context = { host: "github.com", operation: "test" };
it.effect.each([
  { error: new GitHubNotSignedInError(context), reason: "unauthenticated" },
  { error: new GitHubApiAuthenticationError(context), reason: "unauthenticated" },
  { error: new GitHubApiRateLimitError({ ...context, retryAt: 1234 }), reason: "rate-limited" },
  {
    error: new SourceControlRateLimitPausedError({
      provider: SourceControlProviderKind.make("github"),
      host: "github.com",
      retryAt: 1234,
    }),
    reason: "rate-limited",
  },
  { error: new GitHubApiNotFoundError(context), reason: "not-found" },
  { error: new GitHubApiRequestError({ ...context, cause: "network" }), reason: "failed" },
  { error: new GitHubApiResponseError({ ...context, status: 500 }), reason: "failed" },
])("maps remote failures to $reason", ({ error, reason }) =>
  Effect.gen(function* () {
    const tracker = yield* make(() => Effect.fail(error));
    const failure = yield* tracker
      .listIssues({ ...repository, state: "open", page: 1 })
      .pipe(Effect.flip);
    assert.equal(failure.reason, reason);
    assert.equal(failure.cause, error);
    if ("retryAt" in error) assert.equal(failure.retryAt, 1234);
  }),
);

it.effect("accepts exactly owner/name paths without empty or traversal segments", () =>
  Effect.gen(function* () {
    const tracker = yield* make(() => Effect.die("Path validation must not call GitHub"));
    assert.equal(tracker.repositoryPath("owner/project"), "owner/project");
    for (const path of [
      "project",
      "group/subgroup/project",
      "owner/",
      "/project",
      "../project",
      "owner/..",
      "owner/project?x=1",
    ])
      assert.isNull(tracker.repositoryPath(path));
  }),
);
