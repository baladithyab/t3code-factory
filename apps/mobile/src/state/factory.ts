import { createFactoryEnvironmentAtoms } from "@t3tools/client-runtime/state/factory";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";

export const factoryEnvironment = createFactoryEnvironmentAtoms(connectionAtomRuntime);

// Missing capability on an older server is unsupported, never an empty coordinator list.
export const factoryCoordinatorSupportedAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make(
    (get) =>
      environmentId !== null &&
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
        .capabilities.projectCoordinators === true,
  ).pipe(Atom.withLabel(`mobile-factory-coordinators-supported:${environmentId}`)),
);

// An older server has no acceptance RPC; it must read as unsupported, not as "nothing accepted".
export const factoryAcceptanceSupportedAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make(
    (get) =>
      environmentId !== null &&
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
        .capabilities.factoryAcceptance === true,
  ).pipe(Atom.withLabel(`mobile-factory-acceptance-supported:${environmentId}`)),
);

// Publishing needs the delivery RPCs; an older server must hide the section, not show "no PRs".
export const factoryDeliverySupportedAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make(
    (get) =>
      environmentId !== null &&
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
        .capabilities.factoryDelivery === true,
  ).pipe(Atom.withLabel(`mobile-factory-delivery-supported:${environmentId}`)),
);

// Briefs need the knowledge RPCs; an older server must read as unsupported, not as "no briefs".
export const factoryKnowledgeSupportedAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make(
    (get) =>
      environmentId !== null &&
      get(environmentPresentations.presentationAtom(environmentId))?.serverConfig?.environment
        .capabilities.factoryKnowledge === true,
  ).pipe(Atom.withLabel(`mobile-factory-knowledge-supported:${environmentId}`)),
);
