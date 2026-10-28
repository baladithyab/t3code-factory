import { PositiveInt, SourceControlProviderKind } from "@t3tools/contracts";
import {
  IssueTrackerProviderError,
  type IssueTrackerProviderApi,
  type TrackerIssue,
  type TrackerRepositoryRef,
} from "@t3tools/source-control-core/server/IssueTrackerProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as GitHubRest from "./GitHubRest.ts";

const kind = SourceControlProviderKind.make("github");
const GitHubIssue = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.Literals(["open", "closed"]),
  html_url: Schema.String,
  labels: Schema.Array(Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })])),
  updated_at: Schema.DateTimeUtcFromString,
  pull_request: Schema.optional(Schema.Unknown),
});
const decodeIssue = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubIssue));
const decodeIssues = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(GitHubIssue)));
const toIssue = (issue: typeof GitHubIssue.Type): TrackerIssue => ({
  number: issue.number,
  title: issue.title,
  body: issue.body,
  state: issue.state,
  url: issue.html_url,
  labels: issue.labels.map((label) => (typeof label === "string" ? label : label.name)),
  updatedAt: DateTime.formatIso(issue.updated_at),
});

export const make = Effect.gen(function* () {
  const github = yield* GitHubRest.GitHubRest;
  const request = Effect.fn("GitHubIssueTrackerProvider.request")(function* (
    repository: TrackerRepositoryRef,
    operation: string,
    path: string,
  ) {
    const response = yield* github
      .rest({
        host: repository.host,
        operation,
        path: `repos/${repository.repository}/issues${path}`,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new IssueTrackerProviderError({
              provider: kind,
              operation,
              reason:
                cause._tag === "GitHubApiAuthenticationError" ||
                cause._tag === "GitHubNotSignedInError"
                  ? "unauthenticated"
                  : cause._tag === "GitHubApiRateLimitError" ||
                      cause._tag === "SourceControlRateLimitPausedError"
                    ? "rate-limited"
                    : cause._tag === "GitHubApiNotFoundError"
                      ? "not-found"
                      : "failed",
              detail: "The issue request failed.",
              ...("retryAt" in cause && cause.retryAt !== undefined
                ? { retryAt: cause.retryAt }
                : {}),
              cause,
            }),
        ),
      );
    if (response.truncated || response.invalidUtf8)
      return yield* new IssueTrackerProviderError({
        provider: kind,
        operation,
        reason: response.truncated ? "truncated-response" : "invalid-response",
        detail: "The issue response was incomplete or invalid.",
      });
    return response;
  });
  const listIssues: IssueTrackerProviderApi["listIssues"] = Effect.fn(
    "GitHubIssueTrackerProvider.listIssues",
  )(function* (input) {
    const operation = "issues.list";
    const response = yield* request(
      input,
      operation,
      `?state=${input.state}&per_page=30&page=${input.page}&sort=updated&direction=desc`,
    );
    const raw = yield* decodeIssues(response.body).pipe(
      Effect.mapError(
        (cause) =>
          new IssueTrackerProviderError({
            provider: kind,
            operation,
            reason: "invalid-response",
            detail: "The issue response could not be decoded.",
            cause,
          }),
      ),
    );
    // GitHub paginates issues and PRs together, so an all-PR page must still advance.
    const hasNext = (response.headers.link ?? "")
      .split(",")
      .some((link) => /;\s*rel="next"/.test(link));
    return {
      issues: raw.filter((issue) => issue.pull_request === undefined).map(toIssue),
      nextPage: hasNext ? input.page + 1 : null,
    };
  });
  const getIssue: IssueTrackerProviderApi["getIssue"] = Effect.fn(
    "GitHubIssueTrackerProvider.getIssue",
  )(function* (input) {
    const operation = "issues.get";
    const response = yield* request(input, operation, `/${input.number}`);
    const raw = yield* decodeIssue(response.body).pipe(
      Effect.mapError(
        (cause) =>
          new IssueTrackerProviderError({
            provider: kind,
            operation,
            reason: "invalid-response",
            detail: "The issue response could not be decoded.",
            cause,
          }),
      ),
    );
    if (raw.pull_request !== undefined)
      return yield* new IssueTrackerProviderError({
        provider: kind,
        operation,
        reason: "not-an-issue",
        detail: "The requested item is a pull request.",
      });
    if (raw.number !== input.number)
      return yield* new IssueTrackerProviderError({
        provider: kind,
        operation,
        reason: "invalid-response",
        detail: "The response identified a different issue.",
      });
    return toIssue(raw);
  });
  return {
    kind,
    capabilities: {
      displayName: "GitHub",
      blockedBy: "listing-with-total",
      subIssues: true,
      closeAcceptance: "close-reason",
      publish: true,
      headPinnedMerge: true,
    },
    repositoryPath: (path) => {
      const segments = path.split("/");
      return segments.length === 2 &&
        segments.every(
          (segment) => /^[a-z0-9_.-]+$/i.test(segment) && segment !== "." && segment !== "..",
        )
        ? path
        : null;
    },
    listIssues,
    getIssue,
  } satisfies IssueTrackerProviderApi;
});
