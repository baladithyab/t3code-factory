import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createFactoryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:factory:issues",
      tag: WS_METHODS.factoryListIssues,
      staleTimeMs: 0,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factory:start-issue",
      tag: WS_METHODS.factoryStartIssue,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.projectId,
            input.expectedRepositoryKey,
            input.issueNumber,
          ]),
      },
    }),
  };
}
