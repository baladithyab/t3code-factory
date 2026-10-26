import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  type FactoryReadinessReason,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import {
  GitHubApiAuthenticationError,
  GitHubApiNotFoundError,
  GitHubApiRateLimitError,
  GitHubApiResponseError,
} from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as Relations from "./FactoryIssueRelations.ts";
import * as Store from "../persistence/FactoryIssueRelationStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Identities from "../project/RepositoryIdentityResolver.ts";
import * as Git from "../vcs/GitVcsDriver.ts";

const projectId = ProjectId.make("relations-project");
const input = { projectId, issueNumber: 12 };
const subjectPath = "repos/owner/factory/issues/12";
const listingPath = `${subjectPath}/dependencies/blocked_by?per_page=100&page=1`;
const at = "2026-10-25T00:00:00.000Z";
const subject = (total = 2) => ({
  id: 120,
  state: "open",
  issue_dependencies_summary: { blocked_by: 0, total_blocked_by: total },
});
const blocker = (number: number, stateReason: string | null = "completed", state = "closed") => ({
  id: number * 10,
  number,
  title: `Blocker ${number}`,
  html_url: `https://github.com/owner/factory/issues/${number}`,
  state,
  state_reason: stateReason,
  closed_at: state === "closed" ? at : null,
  repository: { full_name: "owner/factory" },
});
const response = (
  body: unknown,
  headers: Record<string, string> = {},
  overrides: Partial<GitHubRest.GitHubRestResponse> = {},
) =>
  Effect.succeed({
    status: 200,
    body: JSON.stringify(body),
    headers,
    truncated: false,
    invalidUtf8: false,
    ...overrides,
  });
type Remote = GitHubRest.GitHubRest["Service"]["rest"];
const routes =
  (paths: Readonly<Record<string, ReturnType<Remote>>>): Remote =>
  ({ path, host }) =>
    host === "github.com" && paths[path] !== undefined
      ? paths[path]
      : Effect.die(`Unexpected GitHub path ${host}/${path}`);
const identity: RepositoryIdentity = {
  canonicalKey: "github.com/owner/factory",
  provider: "github",
  rootPath: "/repo",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:owner/factory.git",
  },
};
function harness(
  rest: Remote,
  resolve: Identities.RepositoryIdentityResolver["Service"]["resolve"] = () =>
    Effect.succeed(identity),
) {
  const dependencies = Layer.mergeAll(
    Store.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
    Layer.mock(GitHubRest.GitHubRest)({ rest }),
    Layer.succeed(Identities.RepositoryIdentityResolver, { resolve }),
    Layer.mock(Projects.ProjectService)({
      getById: () =>
        Effect.succeed(
          Option.some({
            id: projectId,
            title: "Factory",
            workspaceRoot: "/repo",
            defaultModelSelection: null,
            scripts: [],
            createdAt: at,
            updatedAt: at,
            deletedAt: null,
          }),
        ),
    }),
    Layer.mock(Git.GitVcsDriver)({
      execute: () =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "git@github.com:owner/factory.git",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    }),
  );
  return Relations.layer.pipe(Layer.provideMerge(dependencies));
}
const read = Effect.gen(function* () {
  return (yield* (yield* Relations.FactoryIssueRelations).read(input)).readiness;
});

it.effect(
  "#12 open with blocked_by:0,total_blocked_by:2: #7 completed is accepted, #8 not_planned is closed-unaccepted, complete and blocked without parent or sub_issues reads",
  () =>
    Effect.gen(function* () {
      const readiness = yield* read;
      assert.equal(readiness.status, "blocked");
      assert.isTrue(readiness.complete);
      assert.equal(readiness.listedCount, 2);
      assert.equal(readiness.summaryTotal, 2);
      assert.deepInclude(readiness.edges[0], {
        targetNumber: 7,
        resolution: "accepted",
        stateReason: "completed",
      });
      assert.deepInclude(readiness.edges[1], {
        targetNumber: 8,
        resolution: "closed-unaccepted",
        stateReason: "not_planned",
      });
    }).pipe(
      Effect.provide(
        harness(
          routes({
            [subjectPath]: response(subject()),
            [listingPath]: response([blocker(7), blocker(8, "not_planned")]),
          }),
        ),
      ),
    ),
);
it.effect(
  "a vanished 410 blocker remains a deleted blocking tombstone after rebuilding over the same database",
  () => {
    let removed = false;
    return Effect.gen(function* () {
      assert.equal((yield* read).status, "ready");
      removed = true;
      yield* TestClock.adjust("1 minute");
      const rebuilt = yield* Relations.FactoryIssueRelations.pipe(Effect.provide(Relations.layer));
      const readiness = (yield* rebuilt.read(input)).readiness;
      assert.equal(readiness.status, "blocked");
      assert.deepInclude(readiness.edges[0], {
        targetId: 70,
        status: "deleted",
        resolution: "deleted",
      });
      const rebuiltAgain = yield* Relations.FactoryIssueRelations.pipe(
        Effect.provide(Relations.layer),
      );
      assert.equal((yield* rebuiltAgain.read(input)).readiness.status, "blocked");
    }).pipe(
      Effect.provide(
        harness((request) =>
          routes({
            [subjectPath]: response(subject(removed ? 0 : 1)),
            [listingPath]: response(removed ? [] : [blocker(7)]),
            "repos/owner/factory/issues/7": Effect.fail(
              new GitHubApiResponseError({ host: "github.com", operation: "test", status: 410 }),
            ),
          })(request),
        ),
      ),
    );
  },
);
it.effect.each([
  {
    name: "summary total mismatch",
    remoteSubject: subject(3),
    items: [blocker(7), blocker(8)],
    status: "unknown",
    reason: "partial-listing",
  },
  {
    name: "missing summary",
    remoteSubject: { id: 120, state: "open" },
    items: [],
    status: "unknown",
    reason: "summary-missing",
  },
  {
    name: "closed subject",
    remoteSubject: { ...subject(), state: "closed" },
    items: [],
    status: "not-applicable",
    reason: "closed-subject",
  },
  {
    name: "PR subject",
    remoteSubject: { ...subject(), pull_request: {} },
    items: [],
    status: "not-applicable",
    reason: "closed-subject",
  },
  {
    name: "open blocker",
    remoteSubject: subject(1),
    items: [blocker(7, null, "open")],
    status: "blocked",
    reason: "open-blocker",
  },
  {
    name: "all accepted",
    remoteSubject: subject(),
    items: [blocker(7), blocker(8)],
    status: "ready",
    reason: null,
  },
  { name: "no blockers", remoteSubject: subject(0), items: [], status: "ready", reason: null },
  {
    name: "duplicate closure",
    remoteSubject: subject(1),
    items: [blocker(7, "duplicate")],
    status: "blocked",
    reason: "unaccepted-blocker",
  },
  {
    name: "null closure",
    remoteSubject: subject(1),
    items: [blocker(7, null)],
    status: "blocked",
    reason: "unaccepted-blocker",
  },
  {
    name: "reopened closure",
    remoteSubject: subject(1),
    items: [blocker(7, "reopened")],
    status: "blocked",
    reason: "unaccepted-blocker",
  },
])("derives $name", ({ remoteSubject, items, status, reason }) =>
  Effect.gen(function* () {
    const readiness = yield* read;
    assert.equal(readiness.status, status);
    if (reason !== null) assert.include(readiness.reasons, reason);
  }).pipe(
    Effect.provide(
      harness(
        routes({
          [subjectPath]: response(remoteSubject),
          ...(reason === "closed-subject" || reason === "summary-missing"
            ? {}
            : { [listingPath]: response(items) }),
        }),
      ),
    ),
  ),
);
it.effect.each([
  {
    name: "listing 404",
    failure: new GitHubApiNotFoundError({ host: "github.com", operation: "test" }),
    reason: "inaccessible-blocker",
  },
  {
    name: "rate limit",
    failure: new GitHubApiRateLimitError({ host: "github.com", operation: "test" }),
    reason: "rate-limited",
  },
  {
    name: "authentication",
    failure: new GitHubApiAuthenticationError({ host: "github.com", operation: "test" }),
    reason: "authentication",
  },
  {
    name: "remote failure",
    failure: new GitHubApiResponseError({ host: "github.com", operation: "test", status: 503 }),
    reason: "remote-failure",
  },
])("returns unknown evidence for $name rather than failing the RPC", ({ failure, reason }) =>
  Effect.gen(function* () {
    const readiness = yield* read;
    assert.equal(readiness.status, "unknown");
    assert.include(readiness.reasons, reason);
  }).pipe(
    Effect.provide(
      harness(routes({ [subjectPath]: response(subject()), [listingPath]: Effect.fail(failure) })),
    ),
  ),
);
it.effect.each([
  { status: 200, id: 999, expected: "unverified", verdict: "unknown" },
  { status: 200, id: 70, expected: "removed-at-source", verdict: "ready" },
  { status: 404, id: 70, expected: "inaccessible", verdict: "unknown" },
  { status: 301, id: 70, expected: "moved", verdict: "unknown" },
] satisfies {
  status: number;
  id: number;
  expected: Store.StoredEdge["status"];
  verdict: string;
}[])(
  "resolves vanished cross-repository identity with HTTP $status to $expected",
  ({ status, id, expected, verdict }) => {
    let removed = false;
    return Effect.gen(function* () {
      yield* read;
      removed = true;
      const readiness = yield* read;
      assert.equal(readiness.status, verdict);
      assert.deepInclude(readiness.edges[0], {
        targetId: 70,
        targetRepository: "owner/other",
        status: expected,
      });
    }).pipe(
      Effect.provide(
        harness((request) =>
          routes({
            [subjectPath]: response(subject(removed ? 0 : 1)),
            [listingPath]: response(
              removed ? [] : [{ ...blocker(7), repository: { full_name: "owner/other" } }],
            ),
            "repos/owner/other/issues/7":
              status === 200
                ? response({ id })
                : Effect.fail(
                    new GitHubApiResponseError({ host: "github.com", operation: "test", status }),
                  ),
          })(request),
        ),
      ),
    );
  },
);
it.effect(
  "partial listing never changes stored present edges or the last complete timestamp",
  () => {
    let partial = false;
    return Effect.gen(function* () {
      yield* read;
      const store = yield* Store.FactoryIssueRelationStore;
      const key = { canonicalKey: identity.canonicalKey, issueNumber: 12 };
      const before = yield* store.listEdges(key);
      const baseline = Option.getOrThrow(yield* store.getObservation(key));
      partial = true;
      yield* TestClock.adjust("1 minute");
      const readiness = yield* read;
      assert.equal(readiness.status, "unknown");
      assert.equal(readiness.edges.length, 2);
      assert.deepEqual(yield* store.listEdges(key), before);
      assert.equal(
        Option.getOrThrow(yield* store.getObservation(key)).observedAt,
        baseline.observedAt,
      );
    }).pipe(
      Effect.provide(
        harness((request) =>
          routes({
            [subjectPath]: response(subject()),
            [listingPath]: response(partial ? [blocker(7)] : [blocker(7), blocker(8)]),
          })(request),
        ),
      ),
    );
  },
);
it.effect("follows next links and accepts merged PRs, never unmerged completed PRs", () =>
  Effect.gen(function* () {
    const readiness = yield* read;
    assert.isTrue(readiness.complete);
    assert.equal(readiness.status, "blocked");
    assert.deepEqual(
      readiness.edges.map((edge) => edge.resolution),
      ["accepted", "closed-unaccepted"],
    );
  }).pipe(
    Effect.provide(
      harness(
        routes({
          [subjectPath]: response(subject()),
          [listingPath]: response([{ ...blocker(7), pull_request: { merged_at: at } }], {
            link: `<https://api.github.com/${listingPath.replace("&page=1", "&page=2")}>; rel="next"`,
          }),
          [listingPath.replace("&page=1", "&page=2")]: response([
            { ...blocker(8), pull_request: { merged_at: null } },
          ]),
        }),
      ),
    ),
  ),
);
it.effect.each([
  {
    name: "truncated body",
    answer: response([], {}, { truncated: true }),
    reason: "truncated-response",
  },
  {
    name: "invalid UTF8",
    answer: response([], {}, { invalidUtf8: true }),
    reason: "invalid-response",
  },
  { name: "invalid item", answer: response([{}]), reason: "invalid-response" },
  {
    name: "invalid repository locator",
    answer: response([{ ...blocker(7), repository: { full_name: "owner/.." } }]),
    reason: "invalid-response",
  },
  {
    name: "foreign next link",
    answer: response([], { link: '<https://evil.example/issues?page=2&per_page=100>; rel="next"' }),
    reason: "partial-listing",
  },
  {
    name: "duplicate identity",
    answer: response([blocker(7), blocker(7)]),
    reason: "invalid-response",
  },
] satisfies { name: string; answer: ReturnType<Remote>; reason: FactoryReadinessReason }[])(
  "rejects $name as incomplete",
  ({ answer, reason }) =>
    Effect.gen(function* () {
      const readiness = yield* read;
      assert.isFalse(readiness.complete);
      assert.equal(readiness.status, "unknown");
      assert.include(readiness.reasons, reason);
    }).pipe(
      Effect.provide(
        harness(routes({ [subjectPath]: response(subject()), [listingPath]: answer })),
      ),
    ),
);
it.effect("stops after five pages even when GitHub advertises another page", () =>
  Effect.gen(function* () {
    const readiness = yield* read;
    assert.equal(readiness.status, "unknown");
    assert.include(readiness.reasons, "partial-listing");
  }).pipe(
    Effect.provide(
      harness((request) =>
        routes({
          [subjectPath]: response(subject(0)),
          ...Object.fromEntries(
            [1, 2, 3, 4, 5].map((page) => [
              `${subjectPath}/dependencies/blocked_by?per_page=100&page=${page}`,
              response([], {
                link: `<https://api.github.com/${subjectPath}/dependencies/blocked_by?per_page=100&page=${page + 1}>; rel="next"`,
              }),
            ]),
          ),
        })(request),
      ),
    ),
  ),
);
it.effect("only a stored same-repository cycle including the subject contributes cycle", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryIssueRelationStore;
    const record = (issueNumber: number, targetNumber: number) =>
      store.recordComplete({
        subject: { canonicalKey: identity.canonicalKey, issueNumber },
        observedAt: at,
        listedCount: 1,
        summaryTotal: 1,
        present: [
          {
            targetHost: "github.com",
            targetId: targetNumber * 10,
            targetRepository: "owner/factory",
            targetNumber,
          },
        ],
        tombstones: [],
      });
    yield* record(20, 21);
    yield* record(21, 20);
    assert.equal((yield* read).status, "ready");
    yield* record(7, 12);
    const readiness = yield* read;
    assert.equal(readiness.status, "unknown");
    assert.include(readiness.reasons, "cycle");
  }).pipe(
    Effect.provide(
      harness(
        routes({ [subjectPath]: response(subject(1)), [listingPath]: response([blocker(7)]) }),
      ),
    ),
  ),
);
it.effect("repository resolution errors remain typed RPC failures", () =>
  Effect.gen(function* () {
    const error = yield* read.pipe(Effect.flip);
    assert.equal(error.reason, "missing-repository");
  }).pipe(
    Effect.provide(
      harness(
        () => Effect.die("Unresolved repository reached GitHub"),
        () => Effect.succeed(null),
      ),
    ),
  ),
);

it.effect("a proven blocker outranks unknown tombstones on a complete listing", () =>
  Effect.gen(function* () {
    const store = yield* Store.FactoryIssueRelationStore;
    const key = { canonicalKey: identity.canonicalKey, issueNumber: 12 };
    yield* store.recordComplete({
      subject: key,
      observedAt: at,
      listedCount: 2,
      summaryTotal: 2,
      present: [7, 8].map((number) => ({
        targetHost: "github.com",
        targetId: number * 10,
        targetRepository: "owner/factory",
        targetNumber: number,
      })),
      tombstones: [],
    });
    const readiness = yield* read;
    assert.isTrue(readiness.complete);
    assert.equal(readiness.status, "blocked");
    assert.include(readiness.reasons, "deleted-blocker");
    assert.include(readiness.reasons, "inaccessible-blocker");
  }).pipe(
    Effect.provide(
      harness(
        routes({
          [subjectPath]: response(subject(0)),
          [listingPath]: response([]),
          "repos/owner/factory/issues/7": Effect.fail(
            new GitHubApiResponseError({ host: "github.com", operation: "test", status: 410 }),
          ),
          "repos/owner/factory/issues/8": Effect.fail(
            new GitHubApiNotFoundError({ host: "github.com", operation: "test" }),
          ),
        }),
      ),
    ),
  ),
);
