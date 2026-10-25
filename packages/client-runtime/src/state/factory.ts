import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createFactoryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const coordinatorsGet = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:factory:coordinators:get",
    tag: WS_METHODS.projectCoordinatorsGet,
    staleTimeMs: 0,
  });
  const coordinatorsList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:factory:coordinators:list",
    tag: WS_METHODS.projectCoordinatorsList,
    staleTimeMs: 0,
  });
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
            input.expectedIssueRevision,
          ]),
      },
    }),
    coordinatorsGet,
    coordinatorsList,
    coordinatorsEnsure: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:factory:coordinators:ensure",
      tag: WS_METHODS.projectCoordinatorsEnsure,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.projectId, input.expectedThreadId]),
      },
      // A failed response can still follow a persisted binding or an accepted launch.
      onSettled: ({ environmentId, input }, registry) =>
        Effect.sync(() => {
          registry.refresh(
            coordinatorsGet({ environmentId, input: { projectId: input.projectId } }),
          );
          registry.refresh(coordinatorsList({ environmentId, input: {} }));
        }),
    }),
  };
}

// Review text must expose hidden characters without deleting task content or making a literal
// backslash escape indistinguishable from a control character.
export function factoryIssueReviewText(value: string): string {
  return value.replace(/(?![\t\n])[\p{Cc}\p{Cf}\p{Cs}\\]/gu, (character) => {
    if (character === "\\") return "\\\\";
    let escaped = "";
    for (let index = 0; index < character.length; index += 1) {
      escaped += `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`;
    }
    return escaped;
  });
}
