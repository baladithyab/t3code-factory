import { createFactoryEnvironmentAtoms } from "@t3tools/client-runtime/state/factory";

import { connectionAtomRuntime } from "../connection/runtime";

export const factoryEnvironment = createFactoryEnvironmentAtoms(connectionAtomRuntime);
