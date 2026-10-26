import {
  CommandId,
  EnvironmentAuthorizationError,
  FACTORY_RESEARCH_EVALUATOR_MAX_PATHS,
  FACTORY_RESEARCH_HYPOTHESIS_MAX_CHARS,
  FACTORY_RESEARCH_INSTRUCTIONS_MAX_CHARS,
  FactoryResearchError,
  FactoryResearchProtocolId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type FactoryRepository,
  type FactoryResearchFinding,
  type FactoryResearchFindingReason,
  type FactoryResearchObservation,
  type FactoryResearchProtocol,
  type FactoryResearchRun,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_FACTORY_RESEARCH_SEAL_DRAFT,
  FACTORY_RESEARCH_FINDING_REASONS,
  buildFactoryResearchSealInput,
  buildFactoryResearchAdmitInput,
  buildFactoryResearchLaunchInput,
  checkFactoryResearchSealDraft,
  describeFactoryResearchFailure,
  factoryFindingPresentation,
  factoryFindingReviewJson,
  factoryObservationPresentation,
  factoryProtocolPresentation,
  factoryRunPresentations,
  formatFactoryResearchNumber,
  isFactoryResearchSubmitEnabled,
  researchActionsFor,
  shortFactoryCommit,
  splitFactoryResearchEvaluatorPaths,
  type FactoryResearchPermissions,
  type FactoryResearchSealDraft,
} from "./factoryResearch.logic";

const projectId = ProjectId.make("project-1");
const protocolId = FactoryResearchProtocolId.make("protocol-1");
const model: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const now = Date.parse("2026-10-25T12:00:00.000Z");
const baseCommit = "b".repeat(40);
const candidateCommit = "c".repeat(40);
const laterCommit = "d".repeat(40);

const repository: FactoryRepository = {
  provider: "github",
  host: "github.com",
  repository: "owner/repo",
  canonicalKey: "github.com/owner/repo",
  url: "https://github.com/owner/repo",
};

function protocol(overrides: Partial<FactoryResearchProtocol> = {}): FactoryResearchProtocol {
  return {
    id: protocolId,
    projectId,
    repository,
    baseCommit,
    hypothesis: "A smaller batch lowers validation loss.",
    runCommand: "uv run train.py",
    evaluators: [{ path: "prepare.py", blobOid: "0123456789abcdef0123456789abcdef01234567" }],
    metric: { name: "val_bpb", linePrefix: "val_bpb:", direction: "lower", minimumEffect: 0.01 },
    budget: { maxRuns: 3, maxRunMinutes: 10, expiresAt: "2026-10-27T16:00:00.000Z" },
    revision: "protocol-revision-1",
    sealedAt: "2026-10-24T00:00:00.000Z",
    ...overrides,
  };
}

function observation(
  overrides: Partial<FactoryResearchObservation> = {},
): FactoryResearchObservation {
  return {
    threadId: ThreadId.make("explore-thread"),
    role: "explore",
    commit: candidateCommit,
    recordedAt: "2026-10-25T10:00:00.000Z",
    ancestorOfBase: true,
    evaluators: [{ path: "prepare.py", blobOid: "p0", matchesSealed: true }],
    artifacts: [
      {
        path: "run.log",
        line: 2,
        sha256: "a".repeat(64),
        bytes: 120,
        retention: "inline",
        lineText: "val_bpb: 0.930000",
      },
    ],
    metricValue: 0.93,
    missing: [],
    runCount: 1,
    elapsedMinutes: 4,
    disposition: "acceptable",
    ...overrides,
  };
}

function run(
  threadId: string,
  role: FactoryResearchRun["role"],
  observed: FactoryResearchObservation | null,
  overrides: Partial<FactoryResearchRun> = {},
): FactoryResearchRun {
  return {
    threadId: ThreadId.make(threadId),
    role,
    protocolId,
    protocolRevision: "protocol-revision-1",
    launchedByThreadId: null,
    createdAt: "2026-10-25T09:00:00.000Z",
    task: {
      projectId,
      threadId: ThreadId.make(threadId),
      status: "idle",
      baseRef: baseCommit,
      createdAt: "2026-10-25T09:00:00.000Z",
      modelSelection: model,
      runtimeMode: "approval-required",
      interactionMode: "default",
    },
    observation: observed,
    ...overrides,
  };
}

function finding(overrides: Partial<FactoryResearchFinding> = {}): FactoryResearchFinding {
  return {
    protocolId,
    protocolRevision: "protocol-revision-1",
    status: "unknown",
    reasons: [],
    selectedCommit: null,
    baselineValue: null,
    exploreValue: null,
    verifyValue: null,
    baselineThreadId: null,
    exploreThreadId: null,
    verifyThreadId: null,
    revision: "finding-revision-1",
    ...overrides,
  };
}

const operator: FactoryResearchPermissions = { canLaunch: true, canAdmit: true };

describe("formatFactoryResearchNumber", () => {
  it("drops float noise and keeps small values readable", () => {
    expect(formatFactoryResearchNumber(0.95 - 0.93)).toBe("0.02");
    expect(formatFactoryResearchNumber(0.95)).toBe("0.95");
    expect(formatFactoryResearchNumber(3)).toBe("3");
  });

  it("abbreviates a commit to twelve characters and leaves short ids alone", () => {
    expect(shortFactoryCommit("0123456789abcdef0123")).toBe("0123456789ab");
    expect(shortFactoryCommit("p0")).toBe("p0");
  });
});

describe("factoryProtocolPresentation", () => {
  it("reports the time left in the sealed window and lists the sealed evaluators", () => {
    const presentation = factoryProtocolPresentation(protocol(), now);
    expect(presentation.budget).toMatchObject({
      expired: false,
      runsLabel: "3 runs",
      runMinutesLabel: "10 min per run",
      label: "Window closes in 2d 4h",
    });
    expect(presentation.evaluators).toEqual([
      { path: "prepare.py", blobOid: "0123456789abcdef0123456789abcdef01234567" },
    ]);
    expect(presentation.metricLabel).toContain("val_bpb");
    expect(presentation.metricLabel).toContain("Lower is better");
    expect(presentation.ruleLabel).toContain("0.01 or more below the measured baseline");
  });

  it("switches to hours and minutes inside the last day and reads one run in the singular", () => {
    const soon = protocol({
      budget: { maxRuns: 1, maxRunMinutes: 5, expiresAt: "2026-10-25T14:30:00.000Z" },
    });
    const presentation = factoryProtocolPresentation(soon, now);
    expect(presentation.budget.label).toBe("Window closes in 2h 30m");
    expect(presentation.budget.runsLabel).toBe("1 run");
  });

  it("marks a closed window expired, exactly at the boundary too", () => {
    const closed = protocol({
      budget: { maxRuns: 3, maxRunMinutes: 10, expiresAt: "2026-10-25T12:00:00.000Z" },
    });
    const presentation = factoryProtocolPresentation(closed, now);
    expect(presentation.budget).toMatchObject({
      expired: true,
      remainingMs: null,
      label: "Budget window expired",
    });
  });

  it("treats an unreadable expiry as expired so no launch is promised", () => {
    const presentation = factoryProtocolPresentation(
      protocol({ budget: { maxRuns: 3, maxRunMinutes: 10, expiresAt: "soon" } }),
      now,
    );
    expect(presentation.budget).toMatchObject({
      expired: true,
      label: "Budget window unreadable",
    });
  });

  it("says plainly that an undeclared minimum effect can never support a finding", () => {
    const presentation = factoryProtocolPresentation(
      protocol({
        metric: { name: "acc", linePrefix: "acc:", direction: "higher", minimumEffect: null },
      }),
      now,
    );
    expect(presentation.ruleLabel).toContain("finding stays unknown");
    expect(presentation.metricLabel).toContain("Higher is better");
  });

  it("words a declared higher-is-better rule as above the baseline", () => {
    const presentation = factoryProtocolPresentation(
      protocol({
        metric: { name: "acc", linePrefix: "acc:", direction: "higher", minimumEffect: 2 },
      }),
      now,
    );
    expect(presentation.ruleLabel).toContain("2 or more above the measured baseline");
  });
});

describe("factoryObservationPresentation", () => {
  const sealed = protocol();

  it("shows an acceptable observation's metric with its name, usage and artifact digests", () => {
    const presentation = factoryObservationPresentation(observation(), sealed);
    expect(presentation).toMatchObject({
      dispositionLabel: "Acceptable",
      variant: "success",
      acceptable: true,
      reasons: [],
      metric: "val_bpb 0.93",
      usage: "1 run · 4 min",
    });
    expect(presentation.artifacts).toEqual([
      {
        key: "run.log:2",
        path: "run.log",
        line: 2,
        sha256: "a".repeat(64),
        bytes: 120,
        retentionLabel: "Retained in full",
        lineText: "val_bpb: 0.930000",
      },
    ]);
  });

  it("labels digest-only retention with the inline limit, and says so when no value was read", () => {
    const presentation = factoryObservationPresentation(
      observation({
        metricValue: null,
        artifacts: [
          {
            path: "run.log",
            line: 9,
            sha256: "e".repeat(64),
            bytes: 400_000,
            retention: "digest-only",
            lineText: "val_bpb: 0.9",
          },
        ],
      }),
      sealed,
    );
    expect(presentation.metric).toBeNull();
    expect(presentation.artifacts[0]?.retentionLabel).toBe("Digest only (over 256 KiB)");
  });

  it("names each evaluator that no longer matches the sealed copy", () => {
    const presentation = factoryObservationPresentation(
      observation({
        disposition: "evaluator-changed",
        evaluators: [
          { path: "prepare.py", blobOid: "p1", matchesSealed: false },
          { path: "score.py", blobOid: null, matchesSealed: false },
          { path: "data.py", blobOid: "d0", matchesSealed: true },
        ],
      }),
      sealed,
    );
    expect(presentation).toMatchObject({ dispositionLabel: "Evaluator changed", variant: "error" });
    expect(presentation.reasons).toEqual([
      "prepare.py differs from the copy sealed in the protocol.",
      "score.py could not be read at this commit, so it cannot match the sealed copy.",
    ]);
  });

  it("explains ancestry, citation and budget refusals in the protocol's own terms", () => {
    expect(
      factoryObservationPresentation(
        observation({ disposition: "not-descendant", ancestorOfBase: false }),
        sealed,
      ).reasons,
    ).toEqual(["This commit is not a descendant of the protocol's base commit."]);

    const citation = factoryObservationPresentation(
      observation({
        disposition: "citation-invalid",
        metricValue: null,
        artifacts: [
          {
            path: "run.log",
            line: 99,
            sha256: "f".repeat(64),
            bytes: 10,
            retention: "inline",
            lineText: null,
          },
        ],
      }),
      sealed,
    );
    expect(citation.reasons).toEqual([
      "run.log:99 does not exist in the run's files.",
      "No metric value could be read from the cited lines.",
    ]);

    const over = factoryObservationPresentation(
      observation({ disposition: "over-budget", runCount: 4, elapsedMinutes: 25 }),
      sealed,
    );
    expect(over.variant).toBe("error");
    expect(over.reasons[0]).toContain(
      "4 runs and 25 min against a sealed limit of 3 runs and 10 min",
    );
    expect(over.reasons[0]).toContain("never admissible");
    // The favourable metric is still shown, but nothing marks it acceptable.
    expect(over.metric).toBe("val_bpb 0.93");
    expect(over.acceptable).toBe(false);
  });

  it("reports an unknown observation by what could not be checked, never as a pass", () => {
    const presentation = factoryObservationPresentation(
      observation({
        disposition: "unknown",
        ancestorOfBase: null,
        evaluators: [{ path: "prepare.py", blobOid: null, matchesSealed: false }],
      }),
      sealed,
    );
    expect(presentation.acceptable).toBe(false);
    expect(presentation.reasons).toEqual([
      "The ancestry check against the base commit could not run.",
      "prepare.py could not be read at this commit.",
    ]);
    expect(
      factoryObservationPresentation(observation({ disposition: "unknown" }), sealed).reasons,
    ).toEqual(["The server could not derive a verdict from this evidence."]);
  });

  it("carries what the run reported as missing", () => {
    expect(
      factoryObservationPresentation(observation({ missing: ["seed log"] }), sealed).missing,
    ).toEqual(["seed log"]);
  });
});

describe("factoryFindingPresentation", () => {
  const lower = protocol().metric;

  it("measures each candidate against the baseline in the sealed direction", () => {
    const presentation = factoryFindingPresentation(
      finding({
        status: "supported",
        selectedCommit: candidateCommit,
        baselineValue: 0.95,
        exploreValue: 0.93,
        verifyValue: 0.94,
        baselineThreadId: ThreadId.make("baseline-thread"),
        exploreThreadId: ThreadId.make("explore-thread"),
        verifyThreadId: ThreadId.make("verify-thread"),
      }),
      lower,
    );
    expect(presentation).toMatchObject({
      statusLabel: "Supported",
      variant: "success",
      selectedCommit: candidateCommit,
      minimumEffect: "0.01",
      direction: "Lower is better",
    });
    expect(presentation.values.map(({ key, value, effect }) => ({ key, value, effect }))).toEqual([
      { key: "baseline", value: "0.95", effect: null },
      { key: "explore", value: "0.93", effect: "0.02 better than the baseline" },
      { key: "verify", value: "0.94", effect: "0.01 better than the baseline" },
    ]);
  });

  it("reads a higher-is-better metric the other way round", () => {
    const presentation = factoryFindingPresentation(
      finding({ baselineValue: 70, exploreValue: 68, verifyValue: 70 }),
      { name: "acc", linePrefix: "acc:", direction: "higher", minimumEffect: 1 },
    );
    expect(presentation.values[1]?.effect).toBe("2 worse than the baseline");
    expect(presentation.values[2]?.effect).toBe("no change from the baseline");
    expect(presentation.direction).toBe("Higher is better");
  });

  it("does not invent an effect when there is no baseline or no value", () => {
    const presentation = factoryFindingPresentation(
      finding({ baselineValue: null, exploreValue: 0.9 }),
      lower,
    );
    expect(presentation.values.map(({ value, effect }) => [value, effect])).toEqual([
      ["Not measured", null],
      ["0.9", null],
      ["Not measured", null],
    ]);
  });

  it("says the minimum effect is undeclared and that variance is unmeasured", () => {
    const presentation = factoryFindingPresentation(finding(), {
      ...lower,
      minimumEffect: null,
    });
    expect(presentation.minimumEffect).toBe("None declared");
    expect(presentation.varianceNote).toContain("unmeasured");
    expect(presentation).toMatchObject({ statusLabel: "Unknown", variant: "secondary" });
  });

  it("words every finding reason the server can derive", () => {
    const reasons: ReadonlyArray<FactoryResearchFindingReason> = [
      "rule-not-declared",
      "baseline-missing",
      "explore-missing",
      "verification-missing",
      "verification-not-independent",
      "run-not-acceptable",
      "effect-below-minimum",
      "protocol-expired",
    ];
    // The record's keys are the contract's reasons, so a new reason fails to compile there.
    expect(Object.keys(FACTORY_RESEARCH_FINDING_REASONS).sort()).toEqual([...reasons].sort());
    const presentation = factoryFindingPresentation(
      finding({ status: "unsupported", reasons }),
      lower,
    );
    expect(presentation.statusLabel).toBe("Unsupported");
    expect(presentation.reasons.map(({ reason }) => reason)).toEqual(reasons);
    expect(presentation.reasons.every(({ text }) => text.length > 20)).toBe(true);
  });
});

describe("factoryRunPresentations", () => {
  it("orders runs chronologically and flags a run sealed under another revision", () => {
    const rows = factoryRunPresentations(
      [
        run("verify-thread", "verify", observation({ role: "verify" }), {
          createdAt: "2026-10-25T11:00:00.000Z",
          protocolRevision: "older-revision",
        }),
        run("explore-thread", "explore", null),
      ],
      protocol(),
    );
    expect(
      rows.map(({ key, roleLabel, staleRevision }) => [key, roleLabel, staleRevision]),
    ).toEqual([
      ["explore-thread", "Explore", false],
      ["verify-thread", "Verify", true],
    ]);
    expect(rows[0]).toMatchObject({ commit: null, observation: null });
    expect(rows[0]?.task.label).toBe("Idle");
    expect(rows[1]).toMatchObject({ commit: candidateCommit });
    expect(rows[1]?.observation?.metric).toBe("val_bpb 0.93");
  });

  it("says only explore and verify runs record evidence", () => {
    const rows = factoryRunPresentations(
      [
        run("explore-thread", "explore", null),
        run("verify-thread", "verify", null, { createdAt: "2026-10-25T09:30:00.000Z" }),
        run("implementation-thread", "implementation", null, {
          createdAt: "2026-10-25T10:00:00.000Z",
        }),
      ],
      protocol(),
    );
    expect(rows.map(({ role, recordsEvidence }) => [role, recordsEvidence])).toEqual([
      ["explore", true],
      ["verify", true],
      ["implementation", false],
    ]);
  });
});

describe("researchActionsFor", () => {
  // Room for several runs, so only the behaviour under test can disable an action.
  const sealed = protocol({
    budget: { maxRuns: 10, maxRunMinutes: 10, expiresAt: "2026-10-27T16:00:00.000Z" },
  });
  const explored = run("explore-thread", "explore", observation());
  const baselineRun = run(
    "baseline-thread",
    "explore",
    observation({ commit: baseCommit, metricValue: 0.95, recordedAt: "2026-10-25T09:30:00.000Z" }),
  );

  it("offers a fresh explore run and nothing else on an untouched protocol", () => {
    const actions = researchActionsFor(sealed, finding(), [], operator, now);
    expect(actions.launchExplore).toEqual({ enabled: true, reason: null });
    expect(actions.launchVerify.enabled).toBe(false);
    expect(actions.launchVerify.reason).toContain("acceptable explore run");
    expect(actions.launchVerify.targetCommit).toBeNull();
    expect(actions.admitImplementation.enabled).toBe(false);
    expect(actions.admitImplementation.reason).toContain("supported finding");
  });

  it("explains a missing grant before any other reason", () => {
    const actions = researchActionsFor(
      sealed,
      finding({ status: "supported", exploreThreadId: ThreadId.make("explore-thread") }),
      [explored],
      { canLaunch: false, canAdmit: false },
      now,
    );
    expect(actions.launchExplore.reason).toContain("operate and source control write");
    expect(actions.launchVerify.reason).toContain("operate and source control write");
    expect(actions.admitImplementation.reason).toContain("operate and source control write");
  });

  it("refuses to launch once the window has closed or the run budget is spent", () => {
    const closed = protocol({
      budget: { maxRuns: 3, maxRunMinutes: 10, expiresAt: "2026-10-25T11:59:59.000Z" },
    });
    const expired = researchActionsFor(closed, finding(), [], operator, now);
    expect(expired.launchExplore.enabled).toBe(false);
    expect(expired.launchExplore.reason).toContain("window has closed");

    const spent = researchActionsFor(
      protocol({ budget: { maxRuns: 2, maxRunMinutes: 10, expiresAt: sealed.budget.expiresAt } }),
      finding(),
      [baselineRun, explored],
      operator,
      now,
    );
    expect(spent.launchExplore.enabled).toBe(false);
    expect(spent.launchExplore.reason).toContain("All 2 runs");
  });

  it("does not count implementation runs against the sealed run budget", () => {
    const implementation = run("implementation-thread", "implementation", null);
    const actions = researchActionsFor(
      protocol({ budget: { maxRuns: 1, maxRunMinutes: 10, expiresAt: sealed.budget.expiresAt } }),
      finding(),
      [implementation],
      operator,
      now,
    );
    expect(actions.launchExplore.enabled).toBe(true);
  });

  it("offers verification of the finding's selected commit once an explore run exists", () => {
    const actions = researchActionsFor(
      sealed,
      finding({
        reasons: ["verification-missing"],
        selectedCommit: candidateCommit,
        exploreThreadId: ThreadId.make("explore-thread"),
      }),
      [baselineRun, explored],
      operator,
      now,
    );
    expect(actions.launchVerify).toEqual({
      enabled: true,
      reason: null,
      targetCommit: candidateCommit,
    });
  });

  it("falls back to the latest acceptable explore commit, never the base or an unacceptable run", () => {
    const earlier = run(
      "explore-early",
      "explore",
      observation({ commit: candidateCommit, recordedAt: "2026-10-25T10:00:00.000Z" }),
    );
    const latest = run(
      "explore-late",
      "explore",
      observation({ commit: laterCommit, recordedAt: "2026-10-25T11:00:00.000Z" }),
    );
    const rejected = run(
      "explore-rejected",
      "explore",
      observation({
        commit: "e".repeat(40),
        recordedAt: "2026-10-25T11:30:00.000Z",
        disposition: "evaluator-changed",
      }),
    );
    const actions = researchActionsFor(
      sealed,
      finding({ exploreThreadId: ThreadId.make("explore-late") }),
      [baselineRun, earlier, latest, rejected],
      operator,
      now,
    );
    expect(actions.launchVerify).toMatchObject({ enabled: true, targetCommit: laterCommit });
  });

  it("needs the finding to name an explore thread, and a candidate to verify", () => {
    const withoutThread = researchActionsFor(sealed, finding(), [explored], operator, now);
    expect(withoutThread.launchVerify.enabled).toBe(false);
    const baselineOnly = researchActionsFor(
      sealed,
      finding({ exploreThreadId: ThreadId.make("baseline-thread") }),
      [baselineRun],
      operator,
      now,
    );
    expect(baselineOnly.launchVerify).toMatchObject({ enabled: false, targetCommit: null });
  });

  it("does not offer a second verification for a commit that already has an acceptable one", () => {
    const verified = run(
      "verify-thread",
      "verify",
      observation({ role: "verify", commit: candidateCommit }),
    );
    const done = researchActionsFor(
      sealed,
      finding({
        status: "supported",
        selectedCommit: candidateCommit,
        exploreThreadId: ThreadId.make("explore-thread"),
        verifyThreadId: ThreadId.make("verify-thread"),
      }),
      [baselineRun, explored, verified],
      operator,
      now,
    );
    expect(done.launchVerify).toMatchObject({
      enabled: false,
      targetCommit: candidateCommit,
      reason: "This commit already has an acceptable verification.",
    });

    // An unacceptable verification leaves the commit open to another one.
    const failed = run(
      "verify-failed",
      "verify",
      observation({ role: "verify", commit: candidateCommit, disposition: "over-budget" }),
    );
    const again = researchActionsFor(
      sealed,
      finding({
        reasons: ["run-not-acceptable"],
        selectedCommit: candidateCommit,
        exploreThreadId: ThreadId.make("explore-thread"),
      }),
      [baselineRun, explored, failed],
      operator,
      now,
    );
    expect(again.launchVerify.enabled).toBe(true);
  });

  it("offers admission only for a supported finding", () => {
    const supported = finding({ status: "supported", selectedCommit: candidateCommit });
    expect(researchActionsFor(sealed, supported, [], operator, now).admitImplementation).toEqual({
      enabled: true,
      reason: null,
      mode: "admit",
      task: null,
    });
    for (const status of ["unsupported", "unknown"] as const) {
      expect(
        researchActionsFor(sealed, finding({ status }), [], operator, now).admitImplementation
          .enabled,
      ).toBe(false);
    }
  });

  it("follows the one implementation the server keeps for a protocol", () => {
    const supported = finding({ status: "supported", selectedCommit: candidateCommit });
    const withStatus = (status: FactoryResearchRun["task"]["status"]) => {
      const implementation = run("implementation-thread", "implementation", null);
      return run("implementation-thread", "implementation", null, {
        task: { ...implementation.task, status },
      });
    };
    const admit = (
      status: FactoryResearchRun["task"]["status"],
      overrides: {
        finding?: FactoryResearchFinding;
        permissions?: FactoryResearchPermissions;
      } = {},
    ) =>
      researchActionsFor(
        sealed,
        overrides.finding ?? supported,
        [withStatus(status)],
        overrides.permissions ?? operator,
        now,
      ).admitImplementation;

    expect(admit("launching")).toMatchObject({ mode: "resume", enabled: true });
    expect(admit("missing")).toMatchObject({ mode: "restart", enabled: true });
    for (const status of ["preparing", "running", "idle", "failed", "archived"] as const) {
      expect(admit(status)).toMatchObject({ mode: "open", enabled: true, reason: null });
    }
    expect(admit("idle").task?.threadId).toBe("implementation-thread");
    // Resuming or restarting is an admission, so it needs the grants and a supported finding.
    expect(admit("launching", { permissions: { canLaunch: true, canAdmit: false } })).toMatchObject(
      { mode: "resume", enabled: false },
    );
    expect(admit("missing", { finding: finding({ status: "unknown" }) })).toMatchObject({
      mode: "restart",
      enabled: false,
    });
    // Opening an existing thread asks nothing of the finding or the grants.
    expect(
      admit("running", {
        finding: finding({ status: "unknown" }),
        permissions: { canLaunch: false, canAdmit: false },
      }),
    ).toMatchObject({ mode: "open", enabled: true });
  });

  it("follows the latest implementation when an earlier attempt's thread was deleted", () => {
    const older = run("implementation-old", "implementation", null, {
      createdAt: "2026-10-25T08:00:00.000Z",
    });
    const newer = run("implementation-new", "implementation", null, {
      createdAt: "2026-10-25T10:00:00.000Z",
    });
    const actions = researchActionsFor(
      sealed,
      finding({ status: "supported", selectedCommit: candidateCommit }),
      [{ ...older, task: { ...older.task, status: "missing" } }, newer],
      operator,
      now,
    );
    expect(actions.admitImplementation).toMatchObject({ mode: "open" });
    expect(actions.admitImplementation.task?.threadId).toBe("implementation-new");
  });
});

describe("checkFactoryResearchSealDraft", () => {
  const valid: FactoryResearchSealDraft = {
    hypothesis: "  A smaller batch lowers validation loss.  ",
    runCommand: " uv run train.py ",
    evaluatorPaths: "prepare.py\r\n\r\n  eval/score.py  \n",
    metricName: " val_bpb ",
    linePrefix: " val_bpb: ",
    direction: "lower",
    minimumEffect: "0.01",
    maxRuns: "3",
    maxRunMinutes: "30",
    expiresAt: "2026-10-30T09:15",
    baseRef: " main ",
  };

  it("builds trimmed sealed fields, one evaluator per non-empty line, and a UTC expiry", () => {
    const check = checkFactoryResearchSealDraft(valid, now);
    expect(check).toEqual({
      ok: true,
      fields: {
        hypothesis: "A smaller batch lowers validation loss.",
        runCommand: "uv run train.py",
        evaluatorPaths: ["prepare.py", "eval/score.py"],
        metric: {
          name: "val_bpb",
          linePrefix: "val_bpb:",
          direction: "lower",
          minimumEffect: 0.01,
        },
        budget: {
          maxRuns: 3,
          maxRunMinutes: 30,
          expiresAt: new Date("2026-10-30T09:15").toISOString(),
        },
        baseRef: "main",
      },
    });
  });

  it("treats an empty minimum effect as no declared rule and an empty base ref as HEAD", () => {
    const check = checkFactoryResearchSealDraft(
      { ...valid, minimumEffect: "  ", baseRef: "" },
      now,
    );
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.fields.metric.minimumEffect).toBeNull();
      expect(check.fields.baseRef).toBeUndefined();
    }
  });

  it("accepts a plain decimal minimum effect, including zero and exponents", () => {
    for (const [text, expected] of [
      ["0", 0],
      [".5", 0.5],
      ["2.", 2],
      ["1e-3", 0.001],
    ] as const) {
      const check = checkFactoryResearchSealDraft({ ...valid, minimumEffect: text }, now);
      expect(check.ok && check.fields.metric.minimumEffect).toBe(expected);
    }
  });

  it("rejects a minimum effect that is not a finite, non-negative number", () => {
    for (const text of ["abc", "1e", "Infinity", "0x10", "1,5", "NaN", "--1"]) {
      const check = checkFactoryResearchSealDraft({ ...valid, minimumEffect: text }, now);
      expect(check).toMatchObject({
        ok: false,
        errors: { minimumEffect: "Enter a number, or leave it empty." },
      });
    }
    expect(checkFactoryResearchSealDraft({ ...valid, minimumEffect: "-0.5" }, now)).toMatchObject({
      ok: false,
      errors: { minimumEffect: "The minimum effect cannot be negative." },
    });
  });

  it("reports every empty required field at once", () => {
    const check = checkFactoryResearchSealDraft(
      { ...EMPTY_FACTORY_RESEARCH_SEAL_DRAFT, hypothesis: "  ", runCommand: "\n" },
      now,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(Object.keys(check.errors).sort()).toEqual(
        [
          "evaluatorPaths",
          "expiresAt",
          "hypothesis",
          "linePrefix",
          "metricName",
          "runCommand",
        ].sort(),
      );
    }
  });

  it("bounds the hypothesis, run command and evaluator count like the contract", () => {
    const tooLong = checkFactoryResearchSealDraft(
      { ...valid, hypothesis: "x".repeat(FACTORY_RESEARCH_HYPOTHESIS_MAX_CHARS + 1) },
      now,
    );
    expect(tooLong.ok).toBe(false);
    const atLimit = checkFactoryResearchSealDraft(
      { ...valid, hypothesis: "x".repeat(FACTORY_RESEARCH_HYPOTHESIS_MAX_CHARS) },
      now,
    );
    expect(atLimit.ok).toBe(true);
    const manyPaths = Array.from(
      { length: FACTORY_RESEARCH_EVALUATOR_MAX_PATHS + 1 },
      (_, index) => `eval/${index}.py`,
    ).join("\n");
    expect(
      checkFactoryResearchSealDraft({ ...valid, evaluatorPaths: manyPaths }, now),
    ).toMatchObject({ ok: false, errors: { evaluatorPaths: expect.stringContaining("At most") } });
  });

  it("rejects evaluator paths that are duplicated, absolute, escaping or backslashed", () => {
    const problem = (evaluatorPaths: string) => {
      const check = checkFactoryResearchSealDraft({ ...valid, evaluatorPaths }, now);
      return check.ok ? null : (check.errors.evaluatorPaths ?? null);
    };
    expect(problem("prepare.py\nprepare.py")).toBe("prepare.py is listed more than once.");
    expect(problem("/etc/passwd")).toContain("relative to the repository root");
    expect(problem("C:/repo/prepare.py")).toContain("relative to the repository root");
    expect(problem("../outside.py")).toContain("cannot leave the repository");
    expect(problem("eval/../../x.py")).toContain("cannot leave the repository");
    expect(problem("eval\\score.py")).toContain("forward slashes");
    expect(problem("eval/score.py")).toBeNull();
  });

  it("requires positive whole-number budgets", () => {
    for (const text of ["0", "-1", "1.5", "abc", "", "1e3", "99999999999999999999"]) {
      expect(checkFactoryResearchSealDraft({ ...valid, maxRuns: text }, now)).toMatchObject({
        ok: false,
        errors: { maxRuns: "Maximum runs must be a whole number of at least 1." },
      });
      expect(checkFactoryResearchSealDraft({ ...valid, maxRunMinutes: text }, now)).toMatchObject({
        ok: false,
        errors: {
          maxRunMinutes: "Maximum minutes per run must be a whole number of at least 1.",
        },
      });
    }
  });

  it("requires an expiry that is valid and strictly in the future", () => {
    expect(checkFactoryResearchSealDraft({ ...valid, expiresAt: "" }, now)).toMatchObject({
      ok: false,
      errors: { expiresAt: "Choose when the budget window closes." },
    });
    expect(checkFactoryResearchSealDraft({ ...valid, expiresAt: "tomorrow" }, now)).toMatchObject({
      ok: false,
      errors: { expiresAt: "Enter a valid date and time." },
    });
    expect(
      checkFactoryResearchSealDraft({ ...valid, expiresAt: "2026-10-25T12:00:00.000Z" }, now),
    ).toMatchObject({
      ok: false,
      errors: { expiresAt: "The budget window must close in the future." },
    });
    const next = checkFactoryResearchSealDraft(
      { ...valid, expiresAt: "2026-10-25T12:00:01.000Z" },
      now,
    );
    expect(next.ok && next.fields.budget.expiresAt).toBe("2026-10-25T12:00:01.000Z");
  });

  it("splits evaluator text on either newline style and ignores blanks", () => {
    expect(splitFactoryResearchEvaluatorPaths(" a.py \r\n\n b.py\n")).toEqual(["a.py", "b.py"]);
    expect(splitFactoryResearchEvaluatorPaths("  \n")).toEqual([]);
  });

  it("builds the seal request from the checkout the reviewer chose, omitting an unset base ref", () => {
    const check = checkFactoryResearchSealDraft({ ...valid, baseRef: "" }, now);
    if (!check.ok) throw new Error("expected a valid draft");
    const input = buildFactoryResearchSealInput({
      commandId: CommandId.make("seal-1"),
      projectId,
      repository,
      fields: check.fields,
    });
    expect(input).toEqual({
      commandId: "seal-1",
      projectId,
      expectedRepositoryKey: "github.com/owner/repo",
      hypothesis: "A smaller batch lowers validation loss.",
      runCommand: "uv run train.py",
      evaluatorPaths: ["prepare.py", "eval/score.py"],
      metric: { name: "val_bpb", linePrefix: "val_bpb:", direction: "lower", minimumEffect: 0.01 },
      budget: check.fields.budget,
    });
    expect("baseRef" in input).toBe(false);
    const withRef = checkFactoryResearchSealDraft(valid, now);
    if (!withRef.ok) throw new Error("expected a valid draft");
    expect(
      buildFactoryResearchSealInput({
        commandId: CommandId.make("seal-2"),
        projectId,
        repository,
        fields: withRef.fields,
      }).baseRef,
    ).toBe("main");
  });
});

describe("buildFactoryResearchLaunchInput", () => {
  const base = {
    commandId: CommandId.make("launch-1"),
    projectId,
    repository,
    protocol: { id: protocolId, revision: "protocol-revision-1" },
    modelSelection: model,
    runtimeMode: "approval-required",
    interactionMode: "default",
  } as const;

  it("sends the reviewed protocol revision and omits blank instructions", () => {
    expect(
      buildFactoryResearchLaunchInput({
        ...base,
        role: "explore",
        targetCommit: null,
        instructions: " \n ",
      }),
    ).toEqual({
      commandId: "launch-1",
      projectId,
      expectedRepositoryKey: "github.com/owner/repo",
      protocolId,
      expectedProtocolRevision: "protocol-revision-1",
      role: "explore",
      modelSelection: model,
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
  });

  it("pins a verification to the candidate commit and keeps instructions exactly as typed", () => {
    const input = buildFactoryResearchLaunchInput({
      ...base,
      role: "verify",
      targetCommit: candidateCommit,
      instructions: "  Re-run twice.\n",
    });
    expect(input).toMatchObject({
      role: "verify",
      targetCommit: candidateCommit,
      instructions: "  Re-run twice.\n",
    });
  });

  it("never names a target commit on an explore run, nor invents one for a verification", () => {
    expect(
      "targetCommit" in
        buildFactoryResearchLaunchInput({
          ...base,
          role: "explore",
          targetCommit: candidateCommit,
          instructions: "",
        }),
    ).toBe(false);
    expect(
      "targetCommit" in
        buildFactoryResearchLaunchInput({
          ...base,
          role: "verify",
          targetCommit: null,
          instructions: "",
        }),
    ).toBe(false);
  });
});

describe("buildFactoryResearchAdmitInput", () => {
  it("sends the finding revision the reviewer read and the instructions as typed", () => {
    expect(
      buildFactoryResearchAdmitInput({
        commandId: CommandId.make("admit-1"),
        projectId,
        repository,
        protocolId,
        finding: finding({ revision: "finding-revision-9" }),
        modelSelection: model,
        instructions: "Keep the change small.",
        runtimeMode: "approval-required",
        interactionMode: "default",
        restartDeleted: false,
      }),
    ).toEqual({
      commandId: "admit-1",
      projectId,
      expectedRepositoryKey: "github.com/owner/repo",
      protocolId,
      expectedFindingRevision: "finding-revision-9",
      instructions: "Keep the change small.",
      modelSelection: model,
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
  });

  it("omits blank instructions and marks a restart only when confirmed", () => {
    const options = {
      commandId: CommandId.make("admit-2"),
      projectId,
      repository,
      protocolId,
      finding: finding(),
      modelSelection: model,
      instructions: "   ",
      runtimeMode: "approval-required",
      interactionMode: "default",
    } as const;
    const input = buildFactoryResearchAdmitInput({ ...options, restartDeleted: false });
    expect("instructions" in input).toBe(false);
    expect("restartDeleted" in input).toBe(false);
    expect(
      buildFactoryResearchAdmitInput({ ...options, restartDeleted: true }).restartDeleted,
    ).toBe(true);
  });
});

describe("isFactoryResearchSubmitEnabled", () => {
  const ready = {
    allowed: true,
    pending: false,
    changed: false,
    selection: model,
    instructions: "",
  };

  it("enables only when allowed, idle, current and a model is chosen", () => {
    expect(isFactoryResearchSubmitEnabled(ready)).toBe(true);
    expect(isFactoryResearchSubmitEnabled({ ...ready, allowed: false })).toBe(false);
    expect(isFactoryResearchSubmitEnabled({ ...ready, pending: true })).toBe(false);
    expect(isFactoryResearchSubmitEnabled({ ...ready, selection: null })).toBe(false);
  });

  it("locks resubmission once the reviewed revision is stale", () => {
    expect(isFactoryResearchSubmitEnabled({ ...ready, changed: true })).toBe(false);
  });

  it("allows instructions up to the limit and no further", () => {
    expect(
      isFactoryResearchSubmitEnabled({
        ...ready,
        instructions: "x".repeat(FACTORY_RESEARCH_INSTRUCTIONS_MAX_CHARS),
      }),
    ).toBe(true);
    expect(
      isFactoryResearchSubmitEnabled({
        ...ready,
        instructions: "x".repeat(FACTORY_RESEARCH_INSTRUCTIONS_MAX_CHARS + 1),
      }),
    ).toBe(false);
  });
});

describe("describeFactoryResearchFailure", () => {
  it("maps revision conflicts to the kind that keeps the dialog locked", () => {
    expect(
      describeFactoryResearchFailure(new FactoryResearchError({ reason: "protocol-changed" })),
    ).toMatchObject({ kind: "changed", title: "Protocol changed", reason: "protocol-changed" });
    expect(
      describeFactoryResearchFailure(new FactoryResearchError({ reason: "finding-changed" })),
    ).toMatchObject({ kind: "changed", title: "Finding changed", reason: "finding-changed" });
  });

  it("groups repository, budget and refusal reasons", () => {
    const kind = (reason: FactoryResearchError["reason"]) =>
      describeFactoryResearchFailure(new FactoryResearchError({ reason })).kind;
    for (const reason of [
      "missing-project",
      "missing-repository",
      "unsupported-provider",
      "repository-changed",
    ] as const) {
      expect(kind(reason)).toBe("repository");
    }
    expect(kind("protocol-expired")).toBe("budget");
    expect(kind("budget-exhausted")).toBe("budget");
    expect(kind("verification-not-independent")).toBe("other");
    expect(kind("launch-failure")).toBe("other");
  });

  it("carries the server's own message and titles verification refusals", () => {
    const error = new FactoryResearchError({ reason: "verification-not-independent" });
    expect(describeFactoryResearchFailure(error)).toMatchObject({
      title: "Verification refused",
      message: error.message,
    });
    expect(
      describeFactoryResearchFailure(new FactoryResearchError({ reason: "evaluator-missing" }))
        .title,
    ).toBe("Protocol rejected");
  });

  it("recognises a missing grant and falls back for unknown failures", () => {
    const denied = new EnvironmentAuthorizationError({
      requiredScope: "orchestration:operate",
      message: "This connection requires orchestration:operate.",
    });
    expect(describeFactoryResearchFailure(denied)).toMatchObject({
      kind: "permission",
      title: "Permission required",
    });
    expect(describeFactoryResearchFailure(new Error("socket closed"))).toMatchObject({
      kind: "other",
      message: "socket closed",
      reason: null,
    });
    expect(describeFactoryResearchFailure("odd", "custom fallback").message).toBe(
      "custom fallback",
    );
    expect(describeFactoryResearchFailure(undefined).message).toBe(
      "The environment request failed.",
    );
  });
});

describe("factoryFindingReviewJson", () => {
  it("pins the sealed protocol and the whole finding as parseable, untruncated JSON", () => {
    const sealed = protocol();
    const reviewed = finding({
      status: "supported",
      selectedCommit: candidateCommit,
      baselineValue: 0.95,
      exploreValue: 0.93,
      verifyValue: 0.93,
    });
    const text = factoryFindingReviewJson(sealed, reviewed);
    const parsed: unknown = JSON.parse(text);
    expect(parsed).toEqual({
      protocol: {
        id: sealed.id,
        revision: sealed.revision,
        baseCommit: sealed.baseCommit,
        hypothesis: sealed.hypothesis,
        runCommand: sealed.runCommand,
        evaluators: sealed.evaluators,
        metric: sealed.metric,
        budget: sealed.budget,
      },
      finding: reviewed,
    });
    expect(text).toContain("\n  ");
  });
});
