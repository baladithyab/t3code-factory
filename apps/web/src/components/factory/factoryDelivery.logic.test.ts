import {
  FactoryDeliveryError,
  type FactoryDeliveryIntent,
  type FactoryDeliveryPrepareResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canGrantFactoryDelivery,
  describeDeliveryStatus,
  factoryDeliveryFailureMessage,
  factoryDeliveryGrantDisabledReason,
  mergeGrantDisabledReason,
} from "./factoryDelivery.logic";

describe("factoryDeliveryFailureMessage", () => {
  it.each(["head-moved", "acceptance-stale"] as const)(
    "requires re-acceptance after %s",
    (reason) => {
      expect(factoryDeliveryFailureMessage(new FactoryDeliveryError({ reason }))).toBe(
        "The head moved since acceptance. Re-accept, then prepare again.",
      );
    },
  );

  it("requires another preview after the payload changes", () => {
    expect(
      factoryDeliveryFailureMessage(new FactoryDeliveryError({ reason: "payload-changed" })),
    ).toBe("The title or body changed since the preview. Prepare again.");
  });

  it("explains a competing grant", () => {
    expect(
      factoryDeliveryFailureMessage(new FactoryDeliveryError({ reason: "already-delivering" })),
    ).toBe("A pull request is already being published for this task.");
  });

  it("preserves an unexpected request failure", () => {
    expect(factoryDeliveryFailureMessage(new Error("Connection lost"))).toBe("Connection lost");
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
    expect(factoryDeliveryFailureMessage(new FactoryDeliveryError({ reason }))).toBe(message);
  });

  it("describes merge payload changes and competing grants without publication labels", () => {
    expect(
      factoryDeliveryFailureMessage(
        new FactoryDeliveryError({ reason: "payload-changed" }),
        undefined,
        "merge-pr",
      ),
    ).toBe("The merge details changed since the preview. Prepare again.");
    expect(
      factoryDeliveryFailureMessage(
        new FactoryDeliveryError({ reason: "already-delivering" }),
        undefined,
        "merge-pr",
      ),
    ).toBe("A merge has already been granted for this task.");
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
  } satisfies NonNullable<FactoryDeliveryPrepareResult["pullRequest"]>;
  const eligible = {
    acceptanceCurrent: true,
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
  ] as const)("labels %s %s", (kind, status, message) => {
    expect(describeDeliveryStatus({ kind, status, failure: null })).toBe(message);
  });

  it.each(["publish-pr", "merge-pr"] as const)(
    "preserves failure and lost-response messages for %s",
    (kind) => {
      expect(
        describeDeliveryStatus({ kind, status: "failed", failure: "Host rejected the SHA" }),
      ).toBe("Host rejected the SHA");
      expect(describeDeliveryStatus({ kind, status: "unknown", failure: "Connection lost" })).toBe(
        "The server lost the response. Reconcile to check GitHub.",
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
