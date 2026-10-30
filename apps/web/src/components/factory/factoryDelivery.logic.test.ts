import {
  EnvironmentId,
  FactoryDeliveryError,
  FactoryOriginKey,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type FactoryArtifactDeliveryIntent,
  type FactoryArtifactDeliveryPrepareResult,
  type FactoryCommitDeliveryIntent,
  type FactoryCommitDeliveryPrepareResult,
  type FactoryDeliveryIntent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  artifactDeliveryPrepareResult,
  artifactGrantDisabledReason,
  canGrantFactoryDelivery,
  commitDeliveryPrepareResult,
  describeDeliveryStatus,
  factoryArtifactDeliveryFailure,
  factoryDeliveryFailureMessage,
  factoryDeliveryGrantDisabledReason,
  factoryPublishUnsupportedMessage,
  isArtifactDeliveryIntent,
  isCommitDeliveryIntent,
  mergeGrantDisabledReason,
  parseFactoryIssueNumber,
} from "./factoryDelivery.logic";

describe("factoryDeliveryFailureMessage", () => {
  it.each(["head-moved", "acceptance-stale"] as const)(
    "requires re-acceptance after %s",
    (reason) => {
      expect(factoryDeliveryFailureMessage(new FactoryDeliveryError({ reason }), "GitHub")).toBe(
        "The head moved since acceptance. Re-accept, then prepare again.",
      );
    },
  );

  it("requires another preview after the payload changes", () => {
    expect(
      factoryDeliveryFailureMessage(
        new FactoryDeliveryError({ reason: "payload-changed" }),
        "GitHub",
      ),
    ).toBe("The title or body changed since the preview. Prepare again.");
  });

  it("explains a competing grant", () => {
    expect(
      factoryDeliveryFailureMessage(
        new FactoryDeliveryError({ reason: "already-delivering" }),
        "GitHub",
      ),
    ).toBe("A pull request is already being published for this task.");
  });

  it("preserves an unexpected request failure", () => {
    expect(factoryDeliveryFailureMessage(new Error("Connection lost"), "GitHub")).toBe(
      "Connection lost",
    );
  });

  it.each([
    ["not-published", "Publish the pull request first."],
    [
      "pull-request-head-moved",
      "The pull request head is not the accepted commit. Re-accept and refresh.",
    ],
    ["already-merged", "This pull request is already merged."],
    ["not-mergeable", "GitHub reports the pull request cannot be merged right now."],
  ] as const)("explains merge rejection %s", (reason, message) => {
    expect(factoryDeliveryFailureMessage(new FactoryDeliveryError({ reason }), "GitHub")).toBe(
      message,
    );
  });

  it("describes merge payload changes and competing grants without publication labels", () => {
    expect(
      factoryDeliveryFailureMessage(
        new FactoryDeliveryError({ reason: "payload-changed" }),
        "GitHub",
        undefined,
        "merge-pr",
      ),
    ).toBe("The merge details changed since the preview. Prepare again.");
    expect(
      factoryDeliveryFailureMessage(
        new FactoryDeliveryError({ reason: "already-delivering" }),
        "GitHub",
        undefined,
        "merge-pr",
      ),
    ).toBe("A merge has already been granted for this task.");
  });

  it("names the host in copy that blames it", () => {
    expect(
      factoryDeliveryFailureMessage(
        new FactoryDeliveryError({ reason: "not-mergeable" }),
        "GitLab",
      ),
    ).toBe("GitLab reports the pull request cannot be merged right now.");
  });

  it("explains a refused action on a host that cannot do it, for publishing and merging", () => {
    const error = new FactoryDeliveryError({ reason: "capability-unsupported" });
    expect(factoryDeliveryFailureMessage(error, "GitLab")).toBe(
      "Publishing from GitLab is not supported yet.",
    );
    expect(factoryDeliveryFailureMessage(error, "GitLab", undefined, "merge-pr")).toBe(
      "Merging from GitLab is not supported yet.",
    );
  });

  it.each([
    ["head-moved", "The artifact changed since acceptance. Re-accept it, then prepare again."],
    [
      "acceptance-stale",
      "The artifact changed since acceptance. Re-accept it, then prepare again.",
    ],
    [
      "artifact-changed",
      "The artifact changed since acceptance. Re-accept it, then prepare again.",
    ],
    ["payload-changed", "The comment changed since the preview. Prepare again."],
    ["already-delivering", "A comment is already posted, or being posted, to this issue."],
    ["not-accepted", "Accept the artifact, then prepare again."],
    ["worktree-unavailable", "Restore the task folder, then prepare again."],
    [
      "artifact-too-large",
      "The deliverable is larger than one comment can hold (65,536 characters). It is never truncated or split.",
    ],
    [
      "artifact-not-text",
      "The deliverable is not UTF-8 text, so it cannot be posted as a comment.",
    ],
    [
      "destination-not-found",
      "That issue does not exist in this project's repository, or it is a pull request.",
    ],
    [
      "capability-unsupported",
      "This project's issue tracker cannot receive comments from the Factory yet.",
    ],
  ] as const)(
    "explains artifact delivery rejection %s without pull request copy",
    (reason, message) => {
      expect(
        factoryDeliveryFailureMessage(
          new FactoryDeliveryError({ reason }),
          "GitHub",
          undefined,
          "publish-artifact",
        ),
      ).toBe(message);
    },
  );

  it("shares the copy for reasons every delivery kind raises", () => {
    for (const kind of ["publish-pr", "merge-pr", "publish-artifact"] as const) {
      expect(
        factoryDeliveryFailureMessage(
          new FactoryDeliveryError({ reason: "intent-not-found" }),
          "GitHub",
          undefined,
          kind,
        ),
      ).toBe("This delivery is no longer available. Refresh its status.");
    }
  });

  it("falls back to the server's own message for an artifact reason on a commit delivery", () => {
    expect(
      factoryDeliveryFailureMessage(
        new FactoryDeliveryError({ reason: "artifact-changed" }),
        "GitHub",
      ),
    ).toBe(
      "The deliverable changed since it was accepted. Accept the current file before publishing it.",
    );
  });
});

describe("factoryPublishUnsupportedMessage", () => {
  it("is the whole delivery section for a host that cannot publish", () => {
    expect(factoryPublishUnsupportedMessage("GitLab")).toBe(
      "Publishing from GitLab is not supported yet.",
    );
  });
});

describe("mergeGrantDisabledReason", () => {
  const headSha = "a".repeat(40);
  const pullRequest = {
    number: 123,
    url: "https://github.com/owner/repo/pull/123",
    headSha,
    state: "open",
    mergeability: "mergeable",
    isDraft: false,
    checksSummary: "3 passed",
    mergeMethods: ["merge", "squash", "rebase"],
  } satisfies NonNullable<FactoryCommitDeliveryPrepareResult["pullRequest"]>;
  const eligible = {
    acceptanceCurrent: true,
    displayName: "GitHub",
    hasPermission: true,
    existing: null,
    prepared: { current: true, headSha, pullRequest },
  };

  it("allows a matching head and a failed prior intent", () => {
    expect(mergeGrantDisabledReason(eligible)).toBeNull();
    expect(mergeGrantDisabledReason({ ...eligible, existing: { status: "failed" } })).toBeNull();
  });

  it.each([null, "b".repeat(40)])("refuses an unverified PR head %s", (prHeadSha) => {
    expect(
      mergeGrantDisabledReason({
        ...eligible,
        prepared: { ...eligible.prepared, pullRequest: { ...pullRequest, headSha: prHeadSha } },
      }),
    ).toBe("The pull request head is not the accepted commit. Re-accept and refresh.");
  });

  it("requires a prepare with PR details", () => {
    expect(mergeGrantDisabledReason({ ...eligible, prepared: null })).toBe(
      "Prepare the merge before granting it.",
    );
    expect(
      mergeGrantDisabledReason({
        ...eligible,
        prepared: { ...eligible.prepared, pullRequest: null },
      }),
    ).toBe("Prepare the merge before granting it.");
  });

  it("requires current acceptance in both observations and grant permission", () => {
    expect(mergeGrantDisabledReason({ ...eligible, acceptanceCurrent: false })).toBe(
      "The head moved since acceptance. Re-accept, then prepare again.",
    );
    expect(
      mergeGrantDisabledReason({ ...eligible, prepared: { ...eligible.prepared, current: false } }),
    ).toBe("The head moved since acceptance. Re-accept, then prepare again.");
    expect(mergeGrantDisabledReason({ ...eligible, hasPermission: false })).toBe(
      "Merging needs operate and source-control write permissions on this environment.",
    );
  });

  it.each(["pending", "sending", "unknown", "confirmed"] as const)(
    "refuses another grant for a %s merge",
    (status) => {
      expect(mergeGrantDisabledReason({ ...eligible, existing: { status } })).toBe(
        status === "confirmed"
          ? "This pull request is already merged."
          : "A merge has already been granted for this task.",
      );
    },
  );

  it.each([
    [{ isDraft: true }, "Mark the pull request ready for review before merging."],
    [
      { mergeability: "conflicting" },
      "GitHub reports the pull request cannot be merged right now.",
    ],
    [{ state: "closed" }, "GitHub reports the pull request cannot be merged right now."],
    [{ state: "merged" }, "This pull request is already merged."],
  ] as const)("refuses an ineligible PR: %o", (patch, message) => {
    expect(
      mergeGrantDisabledReason({
        ...eligible,
        prepared: { ...eligible.prepared, pullRequest: { ...pullRequest, ...patch } },
      }),
    ).toBe(message);
  });

  it("leaves checks policy and unknown mergeability to GitHub", () => {
    expect(
      mergeGrantDisabledReason({
        ...eligible,
        prepared: {
          ...eligible.prepared,
          pullRequest: { ...pullRequest, mergeability: "unknown", checksSummary: "1 failing" },
        },
      }),
    ).toBeNull();
  });

  it("names the host that rejects a merge", () => {
    expect(
      mergeGrantDisabledReason({
        ...eligible,
        displayName: "GitLab",
        prepared: {
          ...eligible.prepared,
          pullRequest: { ...pullRequest, mergeability: "conflicting" },
        },
      }),
    ).toBe("GitLab reports the pull request cannot be merged right now.");
  });
});

describe("describeDeliveryStatus", () => {
  it.each([
    ["publish-pr", "pending", "Publishing…"],
    ["publish-pr", "sending", "Publishing…"],
    ["publish-pr", "confirmed", "Published"],
    ["publish-pr", "failed", "Publication failed."],
    ["merge-pr", "pending", "Merging…"],
    ["merge-pr", "sending", "Merging…"],
    ["merge-pr", "confirmed", "Merged"],
    ["merge-pr", "failed", "Merge failed."],
    ["publish-artifact", "pending", "Posting comment…"],
    ["publish-artifact", "sending", "Posting comment…"],
    ["publish-artifact", "confirmed", "Comment posted"],
    ["publish-artifact", "failed", "Posting the comment failed."],
  ] as const)("labels %s %s", (kind, status, message) => {
    expect(describeDeliveryStatus({ kind, status, failure: null }, "GitHub")).toBe(message);
  });

  it.each(["publish-pr", "merge-pr", "publish-artifact"] as const)(
    "preserves failure and lost-response messages for %s",
    (kind) => {
      expect(
        describeDeliveryStatus(
          { kind, status: "failed", failure: "Host rejected the SHA" },
          "GitHub",
        ),
      ).toBe("Host rejected the SHA");
      expect(
        describeDeliveryStatus({ kind, status: "unknown", failure: "Connection lost" }, "GitHub"),
      ).toBe(
        kind === "publish-artifact"
          ? "Connection lost Reconcile to check GitHub."
          : "The server lost the response. Reconcile to check GitHub.",
      );
      expect(
        describeDeliveryStatus({ kind, status: "unknown", failure: "Connection lost" }, "GitLab"),
      ).toBe(
        kind === "publish-artifact"
          ? "Connection lost Reconcile to check GitLab."
          : "The server lost the response. Reconcile to check GitLab.",
      );
    },
  );
});

describe("canGrantFactoryDelivery", () => {
  const eligible = { acceptanceCurrent: true, existing: null, hasPermission: true };

  it("allows a current acceptance with permission and no live intent", () => {
    expect(canGrantFactoryDelivery(eligible)).toBe(true);
    expect(canGrantFactoryDelivery({ ...eligible, existing: { status: "failed" } })).toBe(true);
  });

  it("refuses a stale acceptance or missing permission", () => {
    expect(canGrantFactoryDelivery({ ...eligible, acceptanceCurrent: false })).toBe(false);
    expect(canGrantFactoryDelivery({ ...eligible, hasPermission: false })).toBe(false);
    expect(factoryDeliveryGrantDisabledReason({ ...eligible, hasPermission: false })).toBe(
      "Publishing needs operate and source-control write permissions on this environment.",
    );
  });

  it.each(["pending", "sending", "confirmed", "unknown"] satisfies Array<
    FactoryDeliveryIntent["status"]
  >)("refuses a second publication while an intent is %s", (status) => {
    expect(canGrantFactoryDelivery({ ...eligible, existing: { status } })).toBe(false);
    expect(
      factoryDeliveryGrantDisabledReason({ ...eligible, existing: { status } }),
    ).not.toBeNull();
  });
});

describe("delivery narrowing", () => {
  const repository = {
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    repository: "owner/repo",
    canonicalKey: "github.com/owner/repo",
    url: "https://github.com/owner/repo",
  } as const;
  const projectId = ProjectId.make("project:one");
  const threadId = ThreadId.make("thread:one");
  const environmentId = EnvironmentId.make("environment:one");
  const at = "2026-10-28T00:00:00.000Z";
  const core = {
    threadId,
    projectId,
    payloadDigest: "d".repeat(64),
    grantedBy: environmentId,
    grantedAt: at,
    requestCommandId: "command:one",
    failure: null,
    updatedAt: at,
  } as const;
  const artifactIntent = {
    ...core,
    id: "delivery:artifact",
    originKey: FactoryOriginKey.make("knowledge:brief-one"),
    kind: "publish-artifact",
    acceptanceId: "acceptance:artifact",
    briefId: "brief:one",
    artifactPath: "DELIVERABLE.md",
    artifactSha256: "a".repeat(64),
    artifactBytes: 12,
    repository,
    destinationKey: "comment:github:github.com/owner/repo#53",
    payload: { issueNumber: 53 },
    body: "Findings",
    status: "pending",
    remote: null,
  } satisfies FactoryArtifactDeliveryIntent;
  const commitIntent = {
    ...core,
    id: "delivery:commit",
    originKey: FactoryOriginKey.make("github:github.com/owner/repo#7"),
    kind: "publish-pr",
    acceptanceId: "acceptance:commit",
    repository,
    baseRef: "main",
    baseSha: "b".repeat(40),
    headSha: "c".repeat(40),
    payload: { title: "Title", body: "Body", draft: false },
    status: "pending",
    remote: null,
  } satisfies FactoryCommitDeliveryIntent;
  const artifactPrepared = {
    acceptance: {
      id: "acceptance:artifact",
      briefId: "brief:one",
      threadId,
      projectId,
      artifactPath: "DELIVERABLE.md",
      sha256: "a".repeat(64),
      bytes: 12,
      acceptedAt: at,
      acceptedBy: environmentId,
    },
    current: true,
    repository,
    destination: {
      number: 53,
      title: "Publish the brief",
      state: "open",
      url: "https://github.com/owner/repo/issues/53",
    },
    destinationKey: artifactIntent.destinationKey,
    artifactSha256: artifactIntent.artifactSha256,
    artifactBytes: 12,
    body: "Findings",
    payload: { issueNumber: 53 },
    payloadDigest: "e".repeat(64),
    attempt: "a1dd4aae-d332-49a7-b29d-f35ddaf2f19b",
    existing: null,
  } satisfies FactoryArtifactDeliveryPrepareResult;
  const commitPrepared = {
    acceptance: {
      id: "acceptance:commit",
      originKey: commitIntent.originKey,
      threadId,
      projectId,
      headSha: commitIntent.headSha,
      baseRef: "main",
      baseSha: commitIntent.baseSha,
      acceptedAt: at,
      acceptedBy: environmentId,
      evidenceRefs: [],
    },
    current: true,
    repository,
    baseRef: "main",
    headSha: commitIntent.headSha,
    payload: commitIntent.payload,
    payloadDigest: "e".repeat(64),
    existing: null,
    pullRequest: null,
  } satisfies FactoryCommitDeliveryPrepareResult;

  it("separates the artifact intents of a thread from its commit intents", () => {
    const intents: ReadonlyArray<FactoryDeliveryIntent> = [commitIntent, artifactIntent];
    expect(intents.filter(isArtifactDeliveryIntent)).toEqual([artifactIntent]);
    expect(intents.filter(isCommitDeliveryIntent)).toEqual([commitIntent]);
  });

  it("reads each prepare result only as the shape it is", () => {
    expect(artifactDeliveryPrepareResult(artifactPrepared)).toBe(artifactPrepared);
    expect(artifactDeliveryPrepareResult(commitPrepared)).toBeNull();
    expect(commitDeliveryPrepareResult(commitPrepared)).toBe(commitPrepared);
    expect(commitDeliveryPrepareResult(artifactPrepared)).toBeNull();
    expect(artifactDeliveryPrepareResult(null)).toBeNull();
    expect(commitDeliveryPrepareResult(null)).toBeNull();
  });
});

describe("parseFactoryIssueNumber", () => {
  it.each([
    ["53", 53],
    [" 53 ", 53],
    ["#53", 53],
  ] as const)("reads %j as issue %d", (text, number) => {
    expect(parseFactoryIssueNumber(text)).toBe(number);
  });

  it.each(["", "#", "0", "#0", "-1", "1.5", "12abc", "# 12", "9007199254740993"])(
    "refuses %j instead of guessing an issue",
    (text) => {
      expect(parseFactoryIssueNumber(text)).toBeNull();
    },
  );
});

describe("artifactGrantDisabledReason", () => {
  const eligible = {
    acceptanceCurrent: true,
    existing: null,
    hasPermission: true,
    prepared: { current: true },
  };

  it("allows a prepared comment on a current artifact with permission", () => {
    expect(artifactGrantDisabledReason(eligible)).toBeNull();
    expect(artifactGrantDisabledReason({ ...eligible, existing: { status: "failed" } })).toBeNull();
  });

  it("asks for a preparation before offering a grant", () => {
    expect(artifactGrantDisabledReason({ ...eligible, prepared: null })).toBe(
      "Prepare the comment before granting it.",
    );
  });

  it("refuses once the accepted artifact no longer matches, even when the server just prepared it", () => {
    const message = "The artifact changed since acceptance. Re-accept it, then prepare again.";
    expect(artifactGrantDisabledReason({ ...eligible, acceptanceCurrent: false })).toBe(message);
    expect(artifactGrantDisabledReason({ ...eligible, prepared: { current: false } })).toBe(
      message,
    );
  });

  it.each([
    ["pending", "A comment is already being posted to this issue."],
    ["sending", "A comment is already being posted to this issue."],
    ["unknown", "A comment is already being posted to this issue."],
    ["confirmed", "A comment has already been posted to this issue."],
  ] as const)("refuses a second comment while one is %s", (status, message) => {
    expect(artifactGrantDisabledReason({ ...eligible, existing: { status } })).toBe(message);
  });

  it("names the permissions a grant needs", () => {
    expect(artifactGrantDisabledReason({ ...eligible, hasPermission: false })).toBe(
      "Posting a comment needs operate and source-control write permissions on this environment.",
    );
  });
});

describe("factoryArtifactDeliveryFailure", () => {
  it("flags a capability refusal so it shows as a notice, not an error", () => {
    expect(
      factoryArtifactDeliveryFailure(
        new FactoryDeliveryError({ reason: "capability-unsupported" }),
      ),
    ).toEqual({
      message: "This project's issue tracker cannot receive comments from the Factory yet.",
      unsupported: true,
    });
  });

  it("treats every other failure as an error and keeps an unexpected message", () => {
    expect(
      factoryArtifactDeliveryFailure(new FactoryDeliveryError({ reason: "destination-not-found" }))
        .unsupported,
    ).toBe(false);
    expect(factoryArtifactDeliveryFailure(new Error("Connection lost"))).toEqual({
      message: "Connection lost",
      unsupported: false,
    });
  });
});
