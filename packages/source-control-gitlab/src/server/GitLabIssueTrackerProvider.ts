import {
  PositiveInt,
  SourceControlProviderKind,
  VcsProcessExitError,
  VcsProcessOutputLimitError,
} from "@t3tools/contracts";
import {
  IssueTrackerProviderError,
  type IssueTrackerProviderApi,
  type TrackerIssue,
  type TrackerRepositoryRef,
} from "@t3tools/source-control-core/server/IssueTrackerProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as GitLabCli from "./GitLabCli.ts";

const kind = SourceControlProviderKind.make("gitlab");
const GitLabIssue = Schema.Struct({
  id: PositiveInt,
  iid: PositiveInt,
  issue_type: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  state: Schema.Literals(["opened", "closed"]),
  web_url: Schema.String,
  labels: Schema.Array(Schema.String),
  updated_at: Schema.DateTimeUtcFromString,
});
const decodeIssue = Schema.decodeUnknownEffect(Schema.fromJsonString(GitLabIssue));
const decodeIssues = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(GitLabIssue)));
const isExitError = Schema.is(VcsProcessExitError);
const isOutputLimitError = Schema.is(VcsProcessOutputLimitError);
const toIssue = (issue: typeof GitLabIssue.Type): TrackerIssue => ({
  number: issue.iid,
  title: issue.title,
  body: issue.description,
  state: issue.state === "opened" ? "open" : "closed",
  url: issue.web_url,
  labels: issue.labels,
  updatedAt: DateTime.formatIso(issue.updated_at),
});

export const make = Effect.gen(function* () {
  const gitlab = yield* GitLabCli.GitLabCli;
  const request = Effect.fn("GitLabIssueTrackerProvider.request")(function* (
    repository: TrackerRepositoryRef,
    operation: string,
    path: string,
  ) {
    const response = yield* gitlab
      .execute({
        cwd: repository.cwd,
        args: [
          "api",
          // glab rejects ports in --hostname; cwd selects the checkout's authenticated host.
          ...(repository.host.includes(":") ? [] : ["--hostname", repository.host]),
          "--include",
          `projects/${encodeURIComponent(repository.repository)}/issues${path}`,
        ],
        // GitLab descriptions run to 1 MiB each (GitHub's stop at 64 KiB), and a page holds 30,
        // so a cap sized for GitHub would fail the whole page on a few large, busy issues.
        maxOutputBytes: 48 * 1024 * 1024,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new IssueTrackerProviderError({
              provider: kind,
              operation,
              reason:
                cause._tag === "GitLabCliUnavailableError"
                  ? "missing-tool"
                  : cause._tag === "GitLabCliAuthenticationError"
                    ? "unauthenticated"
                    : cause._tag === "GitLabCliRateLimitError"
                      ? "rate-limited"
                      : isExitError(cause.cause) && cause.cause.failureKind === "not-found"
                        ? "not-found"
                        : isOutputLimitError(cause.cause)
                          ? "truncated-response"
                          : "failed",
              detail: "The issue request failed.",
              cause,
            }),
        ),
      );
    if (response.stdoutTruncated || response.stderrTruncated || response.stdoutInvalidUtf8)
      return yield* new IssueTrackerProviderError({
        provider: kind,
        operation,
        reason:
          response.stdoutTruncated || response.stderrTruncated
            ? "truncated-response"
            : "invalid-response",
        detail: "The issue response was incomplete or invalid.",
      });
    // glab --include prefixes the JSON with an HTTP status line and MIME-style headers.
    const separator = /\r?\n\r?\n/.exec(response.stdout);
    if (separator === null || !/^HTTP\/[\d.]+ 2\d\d\b/.test(response.stdout))
      return yield* new IssueTrackerProviderError({
        provider: kind,
        operation,
        reason: "invalid-response",
        detail: "The issue response headers were invalid.",
      });
    const headers = response.stdout.slice(0, separator.index);
    return {
      body: response.stdout.slice(separator.index + separator[0].length),
      nextPage: /^x-next-page:[ \t]*([^\r\n]*)/im.exec(headers)?.[1]?.trim() ?? "",
    };
  });
  const listIssues: IssueTrackerProviderApi["listIssues"] = Effect.fn(
    "GitLabIssueTrackerProvider.listIssues",
  )(function* (input) {
    const operation = "issues.list";
    const response = yield* request(
      input,
      operation,
      `?state=${input.state === "open" ? "opened" : input.state}&issue_type=issue&per_page=30&page=${input.page}&order_by=updated_at&sort=desc`,
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
    const nextPage = response.nextPage === "" ? null : Number(response.nextPage);
    if (
      nextPage !== null &&
      (!/^[1-9]\d*$/.test(response.nextPage) ||
        !Number.isSafeInteger(nextPage) ||
        nextPage <= input.page)
    )
      return yield* new IssueTrackerProviderError({
        provider: kind,
        operation,
        reason: "invalid-response",
        detail: "The issue pagination header was invalid.",
      });
    return { issues: raw.filter((issue) => issue.issue_type === "issue").map(toIssue), nextPage };
  });
  const getIssue: IssueTrackerProviderApi["getIssue"] = Effect.fn(
    "GitLabIssueTrackerProvider.getIssue",
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
    if (raw.iid !== input.number)
      return yield* new IssueTrackerProviderError({
        provider: kind,
        operation,
        reason: "invalid-response",
        detail: "The response identified a different issue.",
      });
    if (raw.issue_type !== "issue")
      return yield* new IssueTrackerProviderError({
        provider: kind,
        operation,
        reason: "not-an-issue",
        detail: "The requested item is not an issue.",
      });
    return toIssue(raw);
  });
  return {
    kind,
    capabilities: {
      displayName: "GitLab",
      blockedBy: "none",
      subIssues: false,
      closeAcceptance: "none",
      publish: false,
      headPinnedMerge: false,
    },
    repositoryPath: (path) => {
      const segments = path.split("/");
      return segments.length >= 2 &&
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
