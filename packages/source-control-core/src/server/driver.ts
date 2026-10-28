import type { SourceControlProviderKind } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { SourceControlProviderDiscoverySpec } from "./discovery.ts";
import type { IssueTrackerProviderApi } from "./IssueTrackerProvider.ts";
import type { PullRequestProviderApi } from "./PullRequestProvider.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";

export interface SourceControlDriverInstance {
  readonly sourceControl: SourceControlProvider.SourceControlProvider["Service"];
  readonly discovery: SourceControlProviderDiscoverySpec;
  /** Null for a host whose pull requests this build cannot read. */
  readonly pullRequests: PullRequestProviderApi | null;
  /** Null for a host whose issues this build cannot read. */
  readonly issues: IssueTrackerProviderApi | null;
}

export interface SourceControlDriver<R = never> {
  readonly kind: SourceControlProviderKind;
  readonly make: Effect.Effect<SourceControlDriverInstance, never, R>;
}

export const defineSourceControlDriver = <R>(
  driver: SourceControlDriver<R>,
): SourceControlDriver<R> => driver;
