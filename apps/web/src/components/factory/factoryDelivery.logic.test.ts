import { FactoryDeliveryError, type FactoryDeliveryIntent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canGrantFactoryDelivery,
  factoryDeliveryFailureMessage,
  factoryDeliveryGrantDisabledReason,
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
