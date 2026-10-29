import { PositiveInt, SourceControlProviderKind } from "@t3tools/contracts";
import {
  IssueTrackerProviderError,
  type IssueTrackerProviderApi,
  type TrackerIssue,
  type TrackerIssueComment,
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
const GitHubIssueComment = Schema.Struct({
  id: Schema.Int,
  body: Schema.String,
  html_url: Schema.String,
});
const decodeIssue = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubIssue));
const decodeIssues = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(GitHubIssue)));
const decodeComment = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubIssueComment));
const decodeComments = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(GitHubIssueComment)),
);
const toComment = (comment: typeof GitHubIssueComment.Type): TrackerIssueComment => ({
  id: comment.id,
  body: comment.body,
  url: comment.html_url,
});
const hasNextPage = (response: GitHubRest.GitHubRestResponse) =>
  (response.headers.link ?? "").split(",").some((link) => /;\s*rel="next"/.test(link));
const invalidResponse = (operation: string) => (cause: unknown) =>
  new IssueTrackerProviderError({
    provider: kind,
    operation,
    reason: "invalid-response",
    detail: "The issue response could not be decoded.",
    cause,
  });
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
    post?: { readonly body: unknown },
  ) {
    const response = yield* github
      .rest({
        host: repository.host,
        operation,
        path: `repos/${repository.repository}/issues${path}`,
        // A write is one a person granted, so a background read that drained the quota must not
        // refuse it (the same as creating a pull request).
        ...(post === undefined ? {} : { method: "POST", body: post.body, allowReserve: true }),
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
      Effect.mapError(invalidResponse(operation)),
    );
    return {
      issues: raw.filter((issue) => issue.pull_request === undefined).map(toIssue),
      // GitHub paginates issues and PRs together, so an all-PR page must still advance.
      nextPage: hasNextPage(response) ? input.page + 1 : null,
    };
  });
  const getIssue: IssueTrackerProviderApi["getIssue"] = Effect.fn(
    "GitHubIssueTrackerProvider.getIssue",
  )(function* (input) {
    const operation = "issues.get";
    const response = yield* request(input, operation, `/${input.number}`);
    const raw = yield* decodeIssue(response.body).pipe(Effect.mapError(invalidResponse(operation)));
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
  const commentOnIssue: NonNullable<IssueTrackerProviderApi["commentOnIssue"]> = Effect.fn(
    "GitHubIssueTrackerProvider.commentOnIssue",
  )(function* (input) {
    const operation = "issues.comment";
    const response = yield* request(input, operation, `/${input.number}/comments`, {
      body: { body: input.body },
    });
    return toComment(
      yield* decodeComment(response.body).pipe(Effect.mapError(invalidResponse(operation))),
    );
  });
  const listIssueComments: NonNullable<IssueTrackerProviderApi["listIssueComments"]> = Effect.fn(
    "GitHubIssueTrackerProvider.listIssueComments",
  )(function* (input) {
    const operation = "issues.comments.list";
    // The per-issue listing is ascending by creation and takes no sort, so pages run oldest first.
    const response = yield* request(
      input,
      operation,
      `/${input.number}/comments?per_page=100&page=${input.page}`,
    );
    const raw = yield* decodeComments(response.body).pipe(
      Effect.mapError(invalidResponse(operation)),
    );
    return {
      comments: raw.map(toComment),
      nextPage: hasNextPage(response) ? input.page + 1 : null,
    };
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
      issueComment: true,
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
    commentOnIssue,
    listIssueComments,
  } satisfies IssueTrackerProviderApi;
});
