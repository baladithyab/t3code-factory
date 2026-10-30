import {
  EnvironmentId,
  FactoryOriginKey,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type FactoryClaim,
  type FactoryClaimListResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  claimConflicts,
  claimForTask,
  claimOwnerTitle,
  claimProvenance,
  claimsElsewhere,
  describeClaimConflict,
  describeClaimProvenance,
  describeClaimsElsewhere,
  describeUnavailableClaims,
  factoryClaimRowPresentation,
  originKeyForFeedItem,
  originKeyForIssue,
  planClaimTargets,
} from "./factoryClaims.logic";

const here = EnvironmentId.make("env-here");
const there = EnvironmentId.make("env-there");
const third = EnvironmentId.make("env-third");
const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const github = SourceControlProviderKind.make("github");
const gitlab = SourceControlProviderKind.make("gitlab");
const issueKey = originKeyForIssue(github, "github.com/example/repo", 12);

const labels: Record<string, string> = { [here]: "Laptop", [there]: "Dev box", [third]: "CI" };
const labelOf = (id: EnvironmentId) => labels[id] ?? id;

function claim(overrides: Partial<FactoryClaim> = {}): FactoryClaim {
  return {
    originKey: issueKey,
    origin: "github-issue",
    projectId,
    workspaceRoot: "/work/repo",
    threadId: ThreadId.make("thread-1"),
    status: "running",
    baseRef: "main",
    createdAt: "2026-10-26T00:00:00.000Z",
    creationSource: "web",
    admittedBy: here,
    originConflict: false,
    acceptance: null,
    artifactAcceptance: null,
    ...overrides,
  };
}

function result(
  environmentId: EnvironmentId,
  claims: ReadonlyArray<FactoryClaim>,
): FactoryClaimListResult {
  return {
    environmentId,
    repository: {
      provider: github,
      host: "github.com",
      repository: "example/repo",
      canonicalKey: "github.com/example/repo",
      url: "https://github.com/example/repo",
    },
    claims,
    fetchedAt: "2026-10-26T00:00:00.000Z",
  };
}

describe("origin keys", () => {
  it("encodes a GitHub issue as github:<repository>#<number>", () => {
    expect(originKeyForIssue(github, "github.com/example/repo", 12)).toBe(
      "github:github.com/example/repo#12",
    );
  });

  it("encodes a GitLab issue under its own provider prefix, keeping the project path", () => {
    expect(originKeyForIssue(gitlab, "gitlab.com/group/sub/project", 12)).toBe(
      "gitlab:gitlab.com/group/sub/project#12",
    );
    expect(originKeyForIssue(gitlab, "forge.example/repo", 1)).not.toBe(
      originKeyForIssue(github, "forge.example/repo", 1),
    );
  });

  it("encodes a feed item as feed:<repository>|<locator>|<item key>", () => {
    expect(
      originKeyForFeedItem(
        "github.com/example/repo",
        "https://feeds.example.test/tasks.xml",
        "guid:item-1",
      ),
    ).toBe("feed:github.com/example/repo|https%3A//feeds.example.test/tasks.xml|guid%3Aitem-1");
  });

  it("escapes %, |, # and : in every component and keeps slashes", () => {
    expect(originKeyForIssue(github, "a%b|c#d:e/f", 1)).toBe("github:a%25b%7Cc%23d%3Ae/f#1");
    expect(originKeyForFeedItem("r", "l|1", "k|2#3%")).toBe("feed:r|l%7C1|k%7C2%233%25");
  });

  it("matches the server's encoding vectors", () => {
    expect(originKeyForFeedItem("repo", "https://news/feed", "atom:X")).toBe(
      "feed:repo|https%3A//news/feed|atom%3AX",
    );
    expect(originKeyForFeedItem("a%|#:", "b%|#:", "c%|#:")).toBe(
      "feed:a%25%7C%23%3A|b%25%7C%23%3A|c%25%7C%23%3A",
    );
  });

  it("never lets a component forge the next field", () => {
    const forged = originKeyForFeedItem("r", "a|b", "c");
    const honest = originKeyForFeedItem("r", "a", "b|c");
    expect(forged).not.toBe(honest);
  });
});

describe("claimConflicts", () => {
  it("reports nothing when every origin is claimed in one environment", () => {
    const conflicts = claimConflicts(
      new Map([
        [here, result(here, [claim()])],
        [
          there,
          result(there, [
            claim({ originKey: originKeyForIssue(github, "github.com/example/repo", 13) }),
          ]),
        ],
      ]),
    );
    expect(conflicts.size).toBe(0);
  });

  it("treats the same thread in two environments as a copied database", () => {
    const conflicts = claimConflicts(
      new Map([
        [here, result(here, [claim()])],
        [there, result(there, [claim({ admittedBy: here })])],
      ]),
    );
    expect(conflicts.get(issueKey)).toEqual({
      kind: "copied-database",
      environments: [here, there],
    });
  });

  it("treats different threads in two environments as duplicate execution", () => {
    const conflicts = claimConflicts(
      new Map([
        [here, result(here, [claim()])],
        [there, result(there, [claim({ threadId: ThreadId.make("thread-2"), admittedBy: there })])],
      ]),
    );
    expect(conflicts.get(issueKey)).toEqual({
      kind: "duplicate-execution",
      environments: [here, there],
    });
  });

  it("is duplicate execution when any third environment holds a different thread", () => {
    const conflicts = claimConflicts(
      new Map([
        [here, result(here, [claim()])],
        [there, result(there, [claim()])],
        [third, result(third, [claim({ threadId: ThreadId.make("thread-3") })])],
      ]),
    );
    expect(conflicts.get(issueKey)).toEqual({
      kind: "duplicate-execution",
      environments: [here, there, third],
    });
  });

  it("does not turn two claims inside one environment into a cross-environment conflict", () => {
    const conflicts = claimConflicts(
      new Map([
        [
          here,
          result(here, [
            claim(),
            claim({ threadId: ThreadId.make("thread-2"), originConflict: true }),
          ]),
        ],
        [there, result(there, [])],
      ]),
    );
    expect(conflicts.size).toBe(0);
  });

  it("ignores an environment that did not answer rather than reading it as unclaimed", () => {
    const conflicts = claimConflicts(new Map([[here, result(here, [claim()])]]));
    expect(conflicts.size).toBe(0);
  });
});

describe("claimProvenance", () => {
  it("is this environment when the claim was admitted by the answering environment", () => {
    expect(claimProvenance(claim({ admittedBy: here }), here)).toBe("this-environment");
  });

  it("is another environment when a copied database carries a foreign admittedBy", () => {
    expect(claimProvenance(claim({ admittedBy: there }), here)).toBe("another-environment");
  });

  it("is unknown for a claim recorded before provenance existed", () => {
    expect(claimProvenance(claim({ admittedBy: null }), here)).toBe("unknown");
  });

  it("words each provenance without implying ownership moved", () => {
    expect(describeClaimProvenance("this-environment")).toBe("Admitted by this environment.");
    expect(describeClaimProvenance("another-environment")).toContain(
      "Admitted by another environment",
    );
    expect(describeClaimProvenance("unknown")).toContain("Provenance unknown");
  });
});

describe("claimsElsewhere", () => {
  const byEnvironment = new Map([
    [here, result(here, [claim()])],
    [there, result(there, [claim({ threadId: ThreadId.make("thread-2"), status: "running" })])],
  ]);

  it("lists claims for the origin held by other environments only", () => {
    const elsewhere = claimsElsewhere(byEnvironment, issueKey, here);
    expect(elsewhere.map((entry) => entry.environmentId)).toEqual([there]);
  });

  it("is empty when only this environment claims the origin", () => {
    expect(
      claimsElsewhere(
        byEnvironment,
        originKeyForIssue(github, "github.com/example/repo", 99),
        here,
      ),
    ).toEqual([]);
  });

  it("words the dialog warning with the holder and its status, and is silent without one", () => {
    const warning = describeClaimsElsewhere(
      claimsElsewhere(byEnvironment, issueKey, here),
      labelOf,
    );
    expect(warning).toContain("Dev box (running)");
    expect(warning).toContain("nothing merges");
    expect(describeClaimsElsewhere([], labelOf)).toBeNull();
  });
});

describe("claimForTask", () => {
  it("matches the claim by origin and the task's thread", () => {
    const own = claim();
    const result_ = result(here, [claim({ threadId: ThreadId.make("other") }), own]);
    expect(claimForTask(result_, issueKey, { threadId: ThreadId.make("thread-1") })).toBe(own);
  });

  it("is null without a task, an answer, or a matching thread", () => {
    expect(claimForTask(result(here, [claim()]), issueKey, null)).toBeNull();
    expect(claimForTask(undefined, issueKey, { threadId: ThreadId.make("thread-1") })).toBeNull();
    expect(
      claimForTask(result(here, [claim()]), issueKey, { threadId: ThreadId.make("missing") }),
    ).toBeNull();
  });
});

describe("describeClaimConflict", () => {
  it("names the environment count and, for a copied database, the shared thread", () => {
    const presentation = describeClaimConflict(
      { kind: "copied-database", environments: [here, there] },
      labelOf,
    );
    expect(presentation.badge).toBe("Claimed in 2 environments");
    expect(presentation.detail).toContain("Laptop, Dev box");
    expect(presentation.detail).toContain("copied database");
  });

  it("names duplicate execution and says nothing merges", () => {
    const presentation = describeClaimConflict(
      { kind: "duplicate-execution", environments: [here, there, third] },
      labelOf,
    );
    expect(presentation.badge).toBe("Claimed in 3 environments");
    expect(presentation.detail).toContain("runs more than once");
    expect(presentation.detail).toContain("Nothing merges");
  });
});

describe("factoryClaimRowPresentation", () => {
  it("shows artifact acceptance for knowledge work without a git base ref", () => {
    const acceptedAt = "2026-10-27T12:00:00.000Z";
    const knowledge = claim({
      origin: "knowledge-brief",
      originKey: FactoryOriginKey.make("knowledge:brief%3Aone"),
      baseRef: null,
      artifactAcceptance: { sha256: "abcdef0".padEnd(64, "1"), acceptedAt },
    });
    const presentation = factoryClaimRowPresentation({
      claimsByEnvironment: new Map([[here, result(here, [knowledge])]]),
      conflicts: new Map(),
      environmentId: here,
      originKey: knowledge.originKey,
      task: { threadId: knowledge.threadId },
      labelOf,
    });
    expect(presentation.acceptedArtifact).toEqual({ shortSha: "abcdef0", acceptedAt });
    expect(presentation.acceptedCommit).toBeUndefined();
  });

  const claimsByEnvironment = new Map([
    [here, result(here, [claim({ admittedBy: there })])],
    [there, result(there, [claim()])],
  ]);
  const conflicts = claimConflicts(claimsByEnvironment);
  const base = {
    claimsByEnvironment,
    conflicts,
    environmentId: here,
    originKey: issueKey,
    labelOf,
  };

  it("summarizes the accepted commit of the row's own claim without implying it is current", () => {
    const acceptedAt = "2026-10-27T12:00:00.000Z";
    const claims = new Map([
      [
        here,
        result(here, [
          claim({ acceptance: { headSha: "abcdef0123456789", acceptedAt } }),
          claim({
            threadId: ThreadId.make("thread-2"),
            acceptance: { headSha: "123456789abcdef0", acceptedAt },
          }),
        ]),
      ],
    ]);
    expect(
      factoryClaimRowPresentation({
        ...base,
        claimsByEnvironment: claims,
        task: { threadId: ThreadId.make("thread-1") },
      }).acceptedCommit,
    ).toEqual({ shortSha: "abcdef0", acceptedAt });
    expect(factoryClaimRowPresentation({ ...base, task: null }).acceptedCommit).toBeUndefined();
    expect(
      factoryClaimRowPresentation({ ...base, task: { threadId: ThreadId.make("thread-1") } })
        .acceptedCommit,
    ).toBeUndefined();
  });

  it("shows the conflict and the provenance of the row's own claim", () => {
    const presentation = factoryClaimRowPresentation({
      ...base,
      task: { threadId: ThreadId.make("thread-1") },
    });
    expect(presentation.conflict?.badge).toBe("Claimed in 2 environments");
    expect(presentation.provenance).toContain("Admitted by another environment");
  });

  it("shows a GitLab issue claim's conflict and provenance like a GitHub one", () => {
    const gitlabKey = originKeyForIssue(gitlab, "gitlab.com/group/project", 4);
    const gitlabClaim = (overrides: Partial<FactoryClaim> = {}) =>
      claim({ originKey: gitlabKey, origin: "gitlab-issue", ...overrides });
    const claims = new Map([
      [here, result(here, [gitlabClaim({ admittedBy: there })])],
      [there, result(there, [gitlabClaim()])],
    ]);
    const presentation = factoryClaimRowPresentation({
      ...base,
      claimsByEnvironment: claims,
      conflicts: claimConflicts(claims),
      originKey: gitlabKey,
      task: { threadId: ThreadId.make("thread-1") },
    });
    expect(presentation.conflict?.badge).toBe("Claimed in 2 environments");
    expect(presentation.provenance).toContain("Admitted by another environment");
  });

  it("shows a conflict but no provenance for an origin with no task here", () => {
    const presentation = factoryClaimRowPresentation({ ...base, task: null });
    expect(presentation.conflict).not.toBeNull();
    expect(presentation.provenance).toBeNull();
  });

  it("shows neither for an unclaimed origin", () => {
    const presentation = factoryClaimRowPresentation({
      ...base,
      originKey: originKeyForIssue(github, "github.com/example/repo", 99),
      task: { threadId: ThreadId.make("thread-1") },
    });
    expect(presentation).toEqual({ conflict: null, duplicates: null, provenance: null });
  });

  it("shows unknown provenance for a claim written before provenance existed", () => {
    const presentation = factoryClaimRowPresentation({
      ...base,
      claimsByEnvironment: new Map([[here, result(here, [claim({ admittedBy: null })])]]),
      conflicts: new Map(),
      task: { threadId: ThreadId.make("thread-1") },
    });
    expect(presentation.provenance).toContain("Provenance unknown");
  });

  it("flags older records that already claim the origin more than once, within one environment", () => {
    const feedKey = originKeyForFeedItem("github.com/example/repo", "https://feed.test/a", "k");
    const presentation = factoryClaimRowPresentation({
      ...base,
      claimsByEnvironment: new Map([
        [
          here,
          result(here, [
            claim({ originKey: feedKey, origin: "feed-item" }),
            claim({
              originKey: feedKey,
              origin: "feed-item",
              threadId: ThreadId.make("thread-2"),
              originConflict: true,
            }),
          ]),
        ],
      ]),
      conflicts: new Map(),
      originKey: feedKey,
      task: { threadId: ThreadId.make("thread-1") },
    });
    expect(presentation.conflict).toBeNull();
    expect(presentation.duplicates?.badge).toBe("Claimed more than once");
    expect(presentation.duplicates?.detail).toContain("Laptop holds 2 older claims");
    expect(presentation.duplicates?.detail).toContain("further admissions are refused");
  });
});

describe("claimOwnerTitle", () => {
  const titles = new Map([[otherProjectId, "apps/server"]]);

  it("names the other checkout that owns the task", () => {
    expect(claimOwnerTitle({ projectId: otherProjectId }, projectId, titles)).toBe("apps/server");
  });

  it("falls back when the owning project is not in the list", () => {
    expect(claimOwnerTitle({ projectId: ProjectId.make("gone") }, projectId, titles)).toBe(
      "another project",
    );
  });

  it("is null for this checkout's own task or no task", () => {
    expect(claimOwnerTitle({ projectId }, projectId, titles)).toBeNull();
    expect(claimOwnerTitle(null, projectId, titles)).toBeNull();
  });
});

describe("planClaimTargets", () => {
  const current = { environmentId: here, projectId, repositoryKey: "github.com/example/repo" };
  const environment = (id: EnvironmentId, overrides = {}) => ({
    environmentId: id,
    label: labelOf(id),
    connected: true,
    claimsSupported: true,
    canRead: true,
    ...overrides,
  });
  const project = (id: EnvironmentId, projectKey: ProjectId, repositoryKey: string | null) => ({
    environmentId: id,
    id: projectKey,
    repositoryKey,
  });

  it("asks the selected environment and every readable environment with the same repository", () => {
    const plan = planClaimTargets({
      current,
      environments: [environment(here), environment(there), environment(third)],
      projects: [
        project(there, otherProjectId, "GitHub.com/Example/Repo"),
        project(third, ProjectId.make("unrelated"), "github.com/example/other"),
      ],
    });
    expect(plan.targets).toEqual([
      { environmentId: here, projectId },
      { environmentId: there, projectId: otherProjectId },
    ]);
    expect(plan.unavailable).toEqual([]);
  });

  it("asks an environment once even when it holds several checkouts", () => {
    const plan = planClaimTargets({
      current,
      environments: [environment(here), environment(there)],
      projects: [
        project(there, otherProjectId, "github.com/example/repo"),
        project(there, ProjectId.make("project-3"), "github.com/example/repo"),
      ],
    });
    expect(plan.targets.filter((target) => target.environmentId === there)).toEqual([
      { environmentId: there, projectId: otherProjectId },
    ]);
  });

  it("reports an offline, outdated or unreadable environment as unavailable, not as empty", () => {
    const plan = planClaimTargets({
      current,
      environments: [
        environment(here),
        environment(there, { connected: false }),
        environment(third, { claimsSupported: false }),
        environment(EnvironmentId.make("env-fourth"), { canRead: false }),
      ],
      projects: [
        project(there, otherProjectId, "github.com/example/repo"),
        project(third, ProjectId.make("p3"), "github.com/example/repo"),
        project(EnvironmentId.make("env-fourth"), ProjectId.make("p4"), "github.com/example/repo"),
      ],
    });
    expect(plan.targets).toEqual([{ environmentId: here, projectId }]);
    expect(plan.unavailable.map((entry) => entry.reason)).toEqual([
      "offline",
      "unsupported",
      "no-access",
    ]);
  });

  it("asks only the selected environment when the checkout has no repository identity", () => {
    const plan = planClaimTargets({
      current: { ...current, repositoryKey: null },
      environments: [environment(here), environment(there)],
      projects: [project(there, otherProjectId, "github.com/example/repo")],
    });
    expect(plan.targets).toEqual([{ environmentId: here, projectId }]);
    expect(plan.unavailable).toEqual([]);
  });

  it("ignores environments that hold no checkout of the repository", () => {
    const plan = planClaimTargets({
      current,
      environments: [environment(here), environment(there, { connected: false })],
      projects: [],
    });
    expect(plan.unavailable).toEqual([]);
  });
});

describe("describeUnavailableClaims", () => {
  it("lists each environment with why it could not be read", () => {
    expect(
      describeUnavailableClaims(
        [
          { environmentId: there, reason: "offline" },
          { environmentId: third, reason: "unsupported" },
        ],
        labelOf,
      ),
    ).toBe(
      "Claims could not be read from Dev box (offline), CI (server needs an update). An origin may be claimed there too.",
    );
  });

  it("is silent when every environment answered", () => {
    expect(describeUnavailableClaims([], labelOf)).toBeNull();
  });
});
