import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type FactoryArtifactDeliveryIntent,
  type FactoryArtifactDeliveryPrepareResult,
  type FactoryDeliveryPrepareResult,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useContext, useLayoutEffect, useRef, useState } from "react";

import { uuidv4 } from "../../lib/uuid";
import { factoryDeliverySupportedAtom, factoryEnvironment } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  describeFactoryArtifactDeliveryFailure,
  isFactoryArtifactIntent,
  isFactoryArtifactPrepareResult,
  type FactoryFailure,
} from "./factoryIssues";

const NO_ARTIFACT_PREVIEW = Atom.make(
  AsyncResult.initial<FactoryDeliveryPrepareResult, unknown>(false),
).pipe(Atom.withLabel("mobile-factory-artifact-delivery-preview:none"));

type ArtifactPreview = AsyncResult.AsyncResult<FactoryDeliveryPrepareResult, unknown>;

// Only a settled success is grantable: a failed re-prepare must not leave the previous digest
// looking current, and a preview that is still re-reading may be about to change.
function settledArtifactPreview(
  preview: ArtifactPreview,
): FactoryArtifactDeliveryPrepareResult | null {
  if (preview._tag !== "Success" || preview.waiting) return null;
  return isFactoryArtifactPrepareResult(preview.value) ? preview.value : null;
}

interface ArtifactDeliveryState {
  readonly key: string;
  // The issue of the last explicit Prepare. Previewing is a read, but it runs only on request
  // so typing never asks the server to render and hash a body per keystroke.
  readonly previewedIssue: number | null;
  readonly pending: boolean;
  readonly failure: FactoryFailure | null;
}

function emptyState(key: string): ArtifactDeliveryState {
  return { key, previewedIssue: null, pending: false, failure: null };
}

/**
 * Posting one accepted artifact as a comment on an issue of the project's own repository. The
 * grant is single-use over the exact preview the human last saw: it echoes that prepare's
 * artifact digest and payload digest, never a fresh read, so a rewritten file or a different
 * rendered body is refused by the server instead of posted. The server renders the body and
 * holds the forge credentials; this hook only previews, grants, and reconciles a lost response.
 */
export function useFactoryArtifactDelivery(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, projectId, threadId } = input;
  const registry = useContext(RegistryContext);
  const supported = useAtomValue(factoryDeliverySupportedAtom(environmentId));
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canGrant = useAtomValue(factoryEnvironment.grantDelivery.permissionAtom(environmentId));
  const canReconcile = useAtomValue(
    factoryEnvironment.reconcileDelivery.permissionAtom(environmentId),
  );
  const readable = supported && canRead;
  const deliveries = useEnvironmentQuery(
    readable
      ? factoryEnvironment.readDeliveries({ environmentId, input: { projectId, threadId } })
      : null,
  );
  const runGrant = useAtomCommand(factoryEnvironment.grantDelivery, { reportFailure: false });
  const runReconcile = useAtomCommand(factoryEnvironment.reconcileDelivery, {
    reportFailure: false,
  });
  const key = JSON.stringify([environmentId, projectId, threadId]);
  const lifetime = useRef<{ readonly key: string; active: boolean; pending: boolean } | null>(null);
  const [state, setState] = useState<ArtifactDeliveryState>(() => emptyState(key));
  if (state.key !== key) setState(emptyState(key));
  useLayoutEffect(() => {
    const current = { key, active: true, pending: false };
    lifetime.current = current;
    return () => {
      current.active = false;
    };
  }, [key]);
  // A settled command only updates the lifetime that sent it.
  const update = useCallback(
    (stateKey: string, patch: Partial<Omit<ArtifactDeliveryState, "key">>) =>
      setState((previous) => (previous.key === stateKey ? { ...previous, ...patch } : previous)),
    [],
  );

  const current = state.key === key ? state : emptyState(key);
  const { previewedIssue } = current;

  const previewAtom: Atom.Atom<ArtifactPreview> =
    readable && previewedIssue !== null
      ? factoryEnvironment.prepareDelivery({
          environmentId,
          input: {
            projectId,
            threadId,
            kind: "publish-artifact",
            payload: { issueNumber: previewedIssue },
          },
        })
      : NO_ARTIFACT_PREVIEW;
  const preview = useAtomValue(previewAtom);
  const refreshPreview = useAtomRefresh(previewAtom);
  const prepared = settledArtifactPreview(preview);
  const previewFailure =
    preview._tag === "Failure"
      ? describeFactoryArtifactDeliveryFailure(Cause.squash(preview.cause), null)
      : null;

  const intents: ReadonlyArray<FactoryArtifactDeliveryIntent> = (
    deliveries.data?.intents ?? []
  ).filter(isFactoryArtifactIntent);

  const prepare = useCallback(
    (issueNumber: number) => {
      if (lifetime.current?.pending) return;
      registry.refresh(
        factoryEnvironment.prepareDelivery({
          environmentId,
          input: {
            projectId,
            threadId,
            kind: "publish-artifact",
            payload: { issueNumber },
          },
        }),
      );
      update(key, { previewedIssue: issueNumber, failure: null });
    },
    [environmentId, key, projectId, registry, threadId, update],
  );

  const grant = useCallback(async () => {
    const current = lifetime.current;
    if (current === null || !current.active || current.pending || prepared === null) return;
    current.pending = true;
    update(current.key, { pending: true, failure: null });
    const result = await runGrant({
      environmentId,
      input: {
        projectId,
        threadId,
        kind: "publish-artifact",
        commandId: uuidv4(),
        expectedArtifactSha256: prepared.artifactSha256,
        expectedPayloadDigest: prepared.payloadDigest,
        attempt: prepared.attempt,
        payload: prepared.payload,
      },
    });
    current.pending = false;
    if (!current.active || lifetime.current !== current) return;
    const failure =
      result._tag === "Failure" && !isAtomCommandInterrupted(result)
        ? describeFactoryArtifactDeliveryFailure(squashAtomCommandFailure(result), null)
        : null;
    update(current.key, {
      pending: false,
      failure,
      ...(result._tag === "Success" ? { previewedIssue: null } : {}),
    });
  }, [environmentId, prepared, projectId, runGrant, threadId, update]);

  const reconcile = useCallback(
    async (intent: FactoryArtifactDeliveryIntent) => {
      const current = lifetime.current;
      if (current === null || !current.active || current.pending) return;
      current.pending = true;
      update(current.key, { pending: true, failure: null });
      const result = await runReconcile({
        environmentId,
        input: { projectId, intentId: intent.id },
      });
      current.pending = false;
      if (!current.active || lifetime.current !== current) return;
      const failure =
        result._tag === "Failure" && !isAtomCommandInterrupted(result)
          ? describeFactoryArtifactDeliveryFailure(squashAtomCommandFailure(result), null)
          : null;
      update(current.key, { pending: false, failure });
    },
    [environmentId, projectId, runReconcile, update],
  );

  const refreshDeliveries = deliveries.refresh;
  const refresh = useCallback(() => {
    if (lifetime.current?.pending) return;
    update(key, { failure: null });
    refreshDeliveries();
    if (previewedIssue !== null) refreshPreview();
  }, [key, previewedIssue, refreshDeliveries, refreshPreview, update]);

  return {
    supported: readable,
    canGrant,
    canReconcile,
    intents,
    deliveriesLoading: deliveries.isPending,
    deliveriesError: deliveries.error,
    prepared,
    preparing: previewedIssue !== null && preview.waiting,
    previewFailure,
    pending: current.pending,
    failure: current.failure,
    prepare,
    grant,
    reconcile,
    refresh,
  };
}
