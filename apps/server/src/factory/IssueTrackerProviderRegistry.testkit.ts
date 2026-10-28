import { SourceControlProviderKind } from "@t3tools/contracts";
import type {
  IssueTrackerCapabilities,
  IssueTrackerProviderApi,
} from "@t3tools/source-control-core/server/IssueTrackerProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { IssueTrackerProviderRegistry, fromProviders } from "./IssueTrackerProviderRegistry.ts";

// The adapters' declared ceilings, so services under test see the same gates production does.
const capabilities = {
  github: {
    displayName: "GitHub",
    blockedBy: "listing-with-total",
    subIssues: true,
    closeAcceptance: "close-reason",
    publish: true,
    headPinnedMerge: true,
  },
  gitlab: {
    displayName: "GitLab",
    blockedBy: "none",
    subIssues: false,
    closeAcceptance: "none",
    publish: false,
    headPinnedMerge: false,
  },
} satisfies Record<string, IssueTrackerCapabilities>;

/** A tracker whose host calls die unless a test supplies them. */
export const fakeIssueTracker = (
  kind: keyof typeof capabilities,
  calls: Partial<Pick<IssueTrackerProviderApi, "listIssues" | "getIssue">> = {},
): IssueTrackerProviderApi => ({
  kind: SourceControlProviderKind.make(kind),
  capabilities: capabilities[kind],
  repositoryPath: (path) => path,
  listIssues: () => Effect.die(`Unexpected ${kind} issue listing`),
  getIssue: () => Effect.die(`Unexpected ${kind} issue read`),
  ...calls,
});

export const issueTrackersLayer = (
  providers: ReadonlyArray<IssueTrackerProviderApi> = [
    fakeIssueTracker("github"),
    fakeIssueTracker("gitlab"),
  ],
) => Layer.succeed(IssueTrackerProviderRegistry, fromProviders(providers));
