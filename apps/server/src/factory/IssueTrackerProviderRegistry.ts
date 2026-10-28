import type { FactoryIssueCapabilities, SourceControlProviderKind } from "@t3tools/contracts";
import type { IssueTrackerProviderApi } from "@t3tools/source-control-core/server/IssueTrackerProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";

export class IssueTrackerProviderRegistry extends Context.Service<
  IssueTrackerProviderRegistry,
  {
    readonly get: (kind: SourceControlProviderKind) => IssueTrackerProviderApi | null;
    readonly kinds: ReadonlyArray<SourceControlProviderKind>;
  }
>()("t3/factory/IssueTrackerProviderRegistry") {}

export const factoryIssueCapabilities = (
  tracker: IssueTrackerProviderApi,
): FactoryIssueCapabilities => ({ provider: tracker.kind, ...tracker.capabilities });

export function fromProviders(
  providers: ReadonlyArray<IssueTrackerProviderApi>,
): IssueTrackerProviderRegistry["Service"] {
  const byKind = new Map(providers.map((provider) => [provider.kind, provider]));
  return {
    get: (kind) => byKind.get(kind) ?? null,
    kinds: providers.map((provider) => provider.kind),
  };
}

/**
 * @public Service construction is part of the canonical Effect module API.
 */
export const make = Effect.gen(function* () {
  const drivers = yield* Effect.forEach(BuiltInDrivers.BUILT_IN_SOURCE_CONTROL_DRIVERS, (driver) =>
    driver.make.pipe(Effect.map((instance) => instance.issues)),
  );
  return fromProviders(
    drivers.filter((provider): provider is IssueTrackerProviderApi => provider !== null),
  );
});

export const layer = Layer.effect(IssueTrackerProviderRegistry, make).pipe(
  Layer.provide(BuiltInDrivers.layer),
);
