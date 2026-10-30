import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as Identities from "../project/RepositoryIdentityResolver.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { makeRepositoryResolver, makeBaseResolver } from "./FactoryTaskLaunch.ts";
import { issueTrackersLayer } from "./IssueTrackerProviderRegistry.testkit.ts";

const projectId = ProjectId.make("origin-refinement");
const at = "2026-10-29T00:00:00.000Z";

it.effect.each([
  { revision: "main", symbolic: "refs/heads/main", remote: "origin", branch: "main" },
  {
    revision: "refs/heads/stable",
    symbolic: "refs/heads/stable",
    remote: "origin",
    branch: "stable",
  },
  { revision: undefined, symbolic: "refs/heads/main", remote: "origin", branch: "main" },
  { revision: "HEAD", symbolic: "refs/heads/main", remote: "origin", branch: "main" },
  {
    revision: "origin/stable",
    symbolic: "refs/remotes/origin/stable",
    remote: "origin",
    branch: "stable",
  },
  { revision: "origin/HEAD", symbolic: "refs/remotes/origin/HEAD", remote: "origin", branch: null },
  {
    revision: "upstream/main",
    symbolic: "refs/remotes/upstream/main",
    remote: "upstream",
    branch: null,
  },
  { revision: "local", symbolic: "refs/heads/local", remote: "upstream", branch: null },
  { revision: "v1", symbolic: "refs/tags/v1", remote: "origin", branch: null },
  { revision: "a".repeat(40), symbolic: "", remote: "origin", branch: null },
  { revision: "HEAD", symbolic: "HEAD", remote: "origin", branch: null },
  {
    revision: "local-only",
    symbolic: "refs/heads/local-only",
    remote: "origin",
    branch: null,
    missing: true,
  },
])("freezes $revision independently of its origin branch destination ($symbolic, $remote)", (row) =>
  Effect.gen(function* () {
    const pinned = yield* (yield* makeBaseResolver)("/repo", row.revision);
    assert.deepEqual(pinned, { baseRef: "a".repeat(40), baseBranch: row.branch });
  }).pipe(
    Effect.provide(
      Layer.mock(Git.GitVcsDriver)({
        resolveCommit: ({ revision }) => {
          assert.equal(
            revision,
            row.symbolic.startsWith("refs/") ? row.symbolic : (row.revision ?? "HEAD"),
          );
          return Effect.succeed({ commitSha: "a".repeat(40) });
        },
        execute: () =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: row.symbolic,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        resolveWorktreeBaseRemote: ({ refName }) =>
          Effect.succeed({ remoteName: row.remote, branchName: refName }),
        remoteBranchExists: () => Effect.succeed(!("missing" in row)),
      }),
    ),
  ),
);
const harness = (origin: string, upstream?: string) => {
  const remotes = `origin ${origin} (fetch)\n${upstream ? `upstream ${upstream} (fetch)\n` : ""}`;
  const identities = Layer.effect(
    Identities.RepositoryIdentityResolver,
    Identities.make({
      // Stand in for the CLI login probes, without inheriting the other remote's provider.
      refine: (identity) =>
        Effect.succeed(
          identity.canonicalKey.startsWith("forge.example/")
            ? { ...identity, provider: SourceControlProviderKind.make("gitlab") }
            : identity.canonicalKey.startsWith("code.example/")
              ? { ...identity, provider: SourceControlProviderKind.make("github") }
              : identity,
        ),
    }),
  ).pipe(
    Layer.provide(
      Layer.succeed(ProcessRunner.ProcessRunner, {
        run: ({ args }) =>
          Effect.succeed({
            code: ChildProcessSpawner.ExitCode(0),
            stdout: args.includes("--show-toplevel") ? "/repo\n" : remotes,
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
      }),
    ),
  );
  return Layer.mergeAll(
    identities,
    issueTrackersLayer(),
    Layer.mock(Projects.ProjectService)({
      getById: () =>
        Effect.succeedSome({
          id: projectId,
          title: "Factory",
          workspaceRoot: "/repo",
          defaultModelSelection: null,
          scripts: [],
          createdAt: at,
          updatedAt: at,
          deletedAt: null,
        }),
    }),
    Layer.mock(Git.GitVcsDriver)({
      execute: () =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: origin,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    }),
  );
};

it.effect.each([
  {
    name: "self-managed origin only",
    origin: "git@forge.example:me/project.git",
    upstream: undefined,
    canonicalKey: "forge.example/me/project",
  },
  {
    name: "self-managed fork with upstream",
    origin: "git@forge.example:me/sub/project.git",
    upstream: "git@forge.example:team/project.git",
    canonicalKey: "forge.example/me/sub/project",
  },
  {
    name: "userless SCP origin",
    origin: "forge.example:me/project.git",
    upstream: "git@github.com:team/project.git",
    canonicalKey: "forge.example/me/project",
  },
  {
    name: "public nested GitLab fork",
    origin: "git@gitlab.com:me/sub/project.git",
    upstream: "git@gitlab.com:team/project.git",
    canonicalKey: "gitlab.com/me/sub/project",
  },
])("resolves $name as GitLab", ({ origin, upstream, canonicalKey }) =>
  Effect.gen(function* () {
    const resolve = yield* makeRepositoryResolver;
    const result = yield* resolve(projectId);
    assert.equal(result.repository.provider, "gitlab");
    assert.equal(result.repository.canonicalKey, canonicalKey);
    assert.equal(result.repository.url, `https://${canonicalKey}`);
  }).pipe(Effect.provide(harness(origin, upstream))),
);

it.effect.each([
  { host: "gitlab.example", provider: SourceControlProviderKind.make("gitlab") },
  { host: "code.example", provider: SourceControlProviderKind.make("github") },
])(
  "preserves the HTTPS authority for $provider without changing its canonical key",
  ({ host, provider }) =>
    Effect.gen(function* () {
      const resolve = yield* makeRepositoryResolver;
      const result = yield* resolve(projectId);
      assert.deepEqual(result.repository, {
        provider,
        host: `${host}:8443`,
        repository: "me/project",
        canonicalKey: `${host}/me/project`,
        url: `https://${host}:8443/me/project`,
      });
    }).pipe(Effect.provide(harness(`https://${host}:8443/me/project.git`))),
);

it.effect("does not inherit a recognized upstream provider for an unknown origin", () =>
  Effect.gen(function* () {
    const resolve = yield* makeRepositoryResolver;
    assert.equal((yield* resolve(projectId).pipe(Effect.flip)).reason, "unsupported-provider");
  }).pipe(
    Effect.provide(
      harness("git@unknown.example:me/project.git", "git@gitlab.com:team/project.git"),
    ),
  ),
);

it.effect("does not treat an SSH transport port as an HTTPS authority port", () =>
  Effect.gen(function* () {
    const resolve = yield* makeRepositoryResolver;
    const result = yield* resolve(projectId);
    assert.equal(result.repository.host, "gitlab.example");
    assert.equal(result.repository.url, "https://gitlab.example/me/project");
  }).pipe(Effect.provide(harness("ssh://git@gitlab.example:2222/me/project.git"))),
);
