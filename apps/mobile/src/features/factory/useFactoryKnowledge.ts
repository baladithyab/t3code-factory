import { useAtomValue } from "@effect/atom-react";
import { factoryIssueReviewText } from "@t3tools/client-runtime/state/factory";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  CommandId,
  type EnvironmentId,
  type FactoryKnowledgeBrief,
  type FactoryKnowledgeStartInput,
  type FactoryKnowledgeTask,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { factoryEnvironment, factoryKnowledgeSupportedAtom } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import type { FactoryFailure } from "./factoryIssues";
import {
  describeFactoryKnowledgeFailure,
  factoryKnowledgeArtifactView,
  factoryKnowledgeCreatePayload,
  factoryKnowledgeDraftProblem,
  factoryKnowledgeStartKey,
  type FactoryKnowledgeAction,
  type FactoryKnowledgeBriefDraft,
} from "./factoryKnowledge";
import { useOpenFactoryThread } from "./useFactoryIssueActions";

interface Lifetime {
  readonly key: string;
  active: boolean;
  pending: boolean;
}

// A settled command only updates the screen lifetime that sent it.
function useLifetime(key: string) {
  const lifetime = useRef<Lifetime | null>(null);
  useLayoutEffect(() => {
    const current: Lifetime = { key, active: true, pending: false };
    lifetime.current = current;
    return () => {
      current.active = false;
    };
  }, [key]);
  return lifetime;
}

/**
 * Authoring one brief. The server mints the id and computes the revision; an unchanged draft
 * retried after a lost response reuses its command id so it cannot create a second brief.
 */
export function useFactoryKnowledgeCreate(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const { environmentId, projectId } = input;
  const canCreate = useAtomValue(
    factoryEnvironment.createKnowledgeBrief.permissionAtom(environmentId),
  );
  const run = useAtomCommand(factoryEnvironment.createKnowledgeBrief, { reportFailure: false });
  const key = JSON.stringify([environmentId, projectId]);
  const lifetime = useLifetime(key);
  const commandIds = useRef(new Map<string, string>());
  const [state, setState] = useState<{
    readonly key: string;
    readonly pending: boolean;
    readonly failure: FactoryFailure | null;
  }>({ key, pending: false, failure: null });
  if (state.key !== key) setState({ key, pending: false, failure: null });

  const create = useCallback(
    async (draft: FactoryKnowledgeBriefDraft): Promise<boolean> => {
      const current = lifetime.current;
      if (current === null || !current.active || current.pending) return false;
      const problem = factoryKnowledgeDraftProblem(draft);
      if (problem !== null) {
        setState({
          key: current.key,
          pending: false,
          failure: { kind: "error", title: "Check the brief", detail: problem },
        });
        return false;
      }
      const payload = factoryKnowledgeCreatePayload(draft);
      const payloadKey = JSON.stringify([current.key, payload]);
      let commandId = commandIds.current.get(payloadKey);
      if (commandId === undefined) {
        commandId = uuidv4();
        commandIds.current.set(payloadKey, commandId);
      }
      current.pending = true;
      setState({ key: current.key, pending: true, failure: null });
      const result = await run({
        environmentId,
        input: { ...payload, commandId: CommandId.make(commandId), projectId },
      });
      current.pending = false;
      if (!current.active || lifetime.current !== current) return false;
      if (result._tag === "Failure") {
        const failure = isAtomCommandInterrupted(result)
          ? null
          : describeFactoryKnowledgeFailure(
              squashAtomCommandFailure(result),
              "Couldn't create the brief",
            );
        setState({ key: current.key, pending: false, failure });
        return false;
      }
      commandIds.current.delete(payloadKey);
      setState({ key: current.key, pending: false, failure: null });
      return true;
    },
    [environmentId, lifetime, projectId, run],
  );

  const dismissFailure = useCallback(() => {
    if (lifetime.current?.pending) return;
    setState({ key, pending: false, failure: null });
  }, [key, lifetime]);

  const current = state.key === key ? state : { pending: false, failure: null };
  return { canCreate, pending: current.pending, failure: current.failure, create, dismissFailure };
}

export interface FactoryKnowledgeStartSettings {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection | null;
  readonly modelLabel: string;
  readonly runtimeMode: RuntimeMode;
}

/** The frozen brief as it will be reviewed: every field, with control characters made visible. */
export interface FactoryKnowledgeReviewSnapshot {
  readonly brief: FactoryKnowledgeBrief;
  readonly modelSelection: ModelSelection;
  readonly modelLabel: string;
  readonly runtimeMode: RuntimeMode;
  readonly restartDeleted: boolean;
  readonly previousThreadId: FactoryKnowledgeTask["threadId"] | null;
  readonly titleText: string;
  readonly questionText: string;
  readonly deliverablePathText: string;
  readonly inputs: ReadonlyArray<{ readonly labelText: string; readonly contentText: string }>;
  readonly criteriaText: string;
}

export interface FactoryKnowledgeReview {
  readonly snapshot: FactoryKnowledgeReviewSnapshot;
  readonly failure: FactoryFailure | null;
}

interface StartLifetime extends Lifetime {
  review: FactoryKnowledgeReview | null;
}

function copyModelSelection(modelSelection: ModelSelection): ModelSelection {
  return {
    ...modelSelection,
    ...(modelSelection.options === undefined
      ? {}
      : { options: modelSelection.options.map((option) => ({ ...option })) }),
  };
}

/**
 * Admitting one frozen brief revision as a task. The review pins the brief and model when it
 * opens; `expectedRevision` comes from that snapshot, so a brief that changed underneath is
 * refused by the server instead of started. Retries of the same reviewed input reuse one command
 * id, and a response cannot navigate or update a different screen lifetime.
 */
export function useFactoryKnowledgeStart(input: {
  readonly settings: FactoryKnowledgeStartSettings;
  readonly scopeKey: string | null;
  readonly onSettled: () => void;
}) {
  const { settings, scopeKey, onSettled } = input;
  const run = useAtomCommand(factoryEnvironment.startKnowledgeTask, { reportFailure: false });
  const openThread = useOpenFactoryThread();
  const lifetime = useRef<StartLifetime | null>(null);
  const commandIds = useRef(new Map<string, string>());
  const [state, setState] = useState<{
    readonly key: string | null;
    readonly busyBrief: string | null;
    readonly review: FactoryKnowledgeReview | null;
  }>({ key: scopeKey, busyBrief: null, review: null });
  if (state.key !== scopeKey) setState({ key: scopeKey, busyBrief: null, review: null });
  useLayoutEffect(() => {
    if (scopeKey === null) {
      lifetime.current = null;
      return;
    }
    const current: StartLifetime = { key: scopeKey, active: true, pending: false, review: null };
    lifetime.current = current;
    return () => {
      current.active = false;
      current.review = null;
    };
  }, [scopeKey]);

  const launch = useCallback(
    async (
      brief: FactoryKnowledgeBrief,
      request: Omit<FactoryKnowledgeStartInput, "commandId">,
      snapshot: FactoryKnowledgeReviewSnapshot | null,
    ) => {
      const current = lifetime.current;
      if (
        current === null ||
        !current.active ||
        current.key !== scopeKey ||
        current.pending ||
        (current.review?.snapshot ?? null) !== snapshot ||
        current.review?.failure?.kind === "changed"
      )
        return;
      const key = factoryKnowledgeStartKey({
        environmentId: settings.environmentId,
        projectId: request.projectId,
        briefId: request.briefId,
        expectedRevision: request.expectedRevision,
        restartDeleted: request.restartDeleted === true,
        previousThreadId: snapshot?.previousThreadId ?? null,
        modelSelection: request.modelSelection,
        runtimeMode: request.runtimeMode ?? null,
        instructions: request.instructions ?? "",
      });
      let commandId = commandIds.current.get(key);
      if (commandId === undefined) {
        commandId = uuidv4();
        commandIds.current.set(key, commandId);
      }
      current.pending = true;
      setState({ key: scopeKey, busyBrief: brief.id, review: current.review });
      const result = await run({
        environmentId: settings.environmentId,
        input: { ...request, commandId: CommandId.make(commandId) },
      });
      current.pending = false;
      if (!current.active || lifetime.current !== current) return;
      if (result._tag === "Failure") {
        const failure = isAtomCommandInterrupted(result)
          ? null
          : describeFactoryKnowledgeFailure(
              squashAtomCommandFailure(result),
              "Couldn't start the task",
            );
        if (current.review !== null) {
          current.review = { ...current.review, failure };
        } else if (failure !== null) {
          Dialog.alert(failure.title, failure.detail);
        }
        setState({ key: scopeKey, busyBrief: null, review: current.review });
        // Refresh only the list. The brief in an open review never changes.
        onSettled();
        return;
      }
      current.review = null;
      setState({ key: scopeKey, busyBrief: null, review: null });
      commandIds.current.delete(key);
      onSettled();
      openThread(settings.environmentId, result.value.task.threadId);
    },
    [onSettled, openThread, run, scopeKey, settings.environmentId],
  );

  const perform = useCallback(
    (brief: FactoryKnowledgeBrief, action: FactoryKnowledgeAction) => {
      const current = lifetime.current;
      if (
        action.kind === "unavailable" ||
        current === null ||
        !current.active ||
        current.key !== scopeKey ||
        current.pending ||
        current.review !== null
      )
        return;
      if (action.kind === "open") {
        openThread(settings.environmentId, action.task.threadId);
        return;
      }
      if (settings.modelSelection === null) {
        Dialog.alert("Choose a model", "Pick a model and provider before starting a task.");
        return;
      }
      if (action.kind === "resume") {
        // The server replays the reserved launch with its saved intent; only the identity of the
        // brief revision is checked again.
        void launch(
          brief,
          {
            projectId: settings.projectId,
            briefId: brief.id,
            expectedRevision: brief.revision,
            modelSelection: copyModelSelection(settings.modelSelection),
            runtimeMode: settings.runtimeMode,
            creationSource: "mobile",
          },
          null,
        );
        return;
      }
      current.review = {
        snapshot: {
          brief: { ...brief, inputs: brief.inputs.map((entry) => ({ ...entry })) },
          modelSelection: copyModelSelection(settings.modelSelection),
          modelLabel: settings.modelLabel,
          runtimeMode: settings.runtimeMode,
          restartDeleted: action.kind === "restart",
          previousThreadId: action.kind === "restart" ? action.task.threadId : null,
          titleText: factoryIssueReviewText(brief.title),
          questionText: factoryIssueReviewText(brief.question),
          deliverablePathText: factoryIssueReviewText(brief.deliverablePath),
          inputs: brief.inputs.map((entry) => ({
            labelText: factoryIssueReviewText(entry.label),
            contentText: factoryIssueReviewText(entry.content),
          })),
          criteriaText: factoryIssueReviewText(brief.acceptanceCriteria),
        },
        failure: null,
      };
      setState({ key: scopeKey, busyBrief: null, review: current.review });
    },
    [launch, openThread, scopeKey, settings],
  );

  const snapshot = state.review?.snapshot ?? null;
  const confirmReview = useCallback(
    (instructions: string) => {
      if (snapshot === null) return;
      const trimmed = instructions.trim();
      void launch(
        snapshot.brief,
        {
          projectId: settings.projectId,
          briefId: snapshot.brief.id,
          expectedRevision: snapshot.brief.revision,
          modelSelection: snapshot.modelSelection,
          runtimeMode: snapshot.runtimeMode,
          ...(trimmed.length === 0 ? {} : { instructions: trimmed }),
          ...(snapshot.restartDeleted ? { restartDeleted: true } : {}),
          creationSource: "mobile",
        },
        snapshot,
      );
    },
    [launch, settings.projectId, snapshot],
  );

  const closeReview = useCallback(() => {
    const current = lifetime.current;
    if (
      current === null ||
      !current.active ||
      current.key !== scopeKey ||
      current.pending ||
      current.review?.snapshot !== snapshot
    )
      return;
    current.review = null;
    setState({ key: scopeKey, busyBrief: null, review: null });
  }, [scopeKey, snapshot]);

  return {
    busyBrief: state.key === scopeKey ? state.busyBrief : null,
    review: state.key === scopeKey ? state.review : null,
    perform,
    confirmReview,
    closeReview,
  };
}

/**
 * The artifact of one brief's task. Accept pins the digest the reviewer was last shown:
 * `expectedSha256` always comes from the last read, never a fresh one, so the server refuses
 * rather than accepting bytes nobody saw. A failure keeps that read on screen with its
 * explanation; only an explicit refresh replaces what the reviewer is looking at.
 */
export function useFactoryKnowledgeTask(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly briefId: string;
}) {
  const { environmentId, projectId, briefId } = input;
  const supported = useAtomValue(factoryKnowledgeSupportedAtom(environmentId));
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canAccept = useAtomValue(
    factoryEnvironment.acceptKnowledgeArtifact.permissionAtom(environmentId),
  );
  const query = useEnvironmentQuery(
    supported && canRead
      ? factoryEnvironment.readKnowledgeTask({ environmentId, input: { projectId, briefId } })
      : null,
  );
  const run = useAtomCommand(factoryEnvironment.acceptKnowledgeArtifact, {
    reportFailure: false,
  });
  const key = JSON.stringify([environmentId, projectId, briefId]);
  const lifetime = useLifetime(key);
  const [state, setState] = useState<{
    readonly key: string;
    readonly pending: boolean;
    readonly failure: FactoryFailure | null;
  }>({ key, pending: false, failure: null });
  if (state.key !== key) setState({ key, pending: false, failure: null });

  const shownSha256 = query.data?.artifact?.sha256 ?? null;
  const refreshQuery = query.refresh;
  const accept = useCallback(
    async (supersede: boolean) => {
      const current = lifetime.current;
      if (current === null || !current.active || current.pending || shownSha256 === null) return;
      current.pending = true;
      setState({ key: current.key, pending: true, failure: null });
      const result = await run({
        environmentId,
        input: {
          projectId,
          briefId,
          expectedSha256: shownSha256,
          ...(supersede ? { supersede: true } : {}),
        },
      });
      current.pending = false;
      if (!current.active || lifetime.current !== current) return;
      if (result._tag === "Failure") {
        const failure = isAtomCommandInterrupted(result)
          ? null
          : describeFactoryKnowledgeFailure(
              squashAtomCommandFailure(result),
              "Couldn't accept the artifact",
            );
        setState({ key: current.key, pending: false, failure });
        return;
      }
      setState({ key: current.key, pending: false, failure: null });
      refreshQuery();
    },
    [briefId, environmentId, lifetime, projectId, refreshQuery, run, shownSha256],
  );

  const refresh = useCallback(() => {
    if (lifetime.current?.pending) return;
    setState({ key, pending: false, failure: null });
    refreshQuery();
  }, [key, lifetime, refreshQuery]);

  const current = state.key === key ? state : { pending: false, failure: null };
  return {
    supported: supported && canRead,
    canAccept,
    view: query.data === null ? null : factoryKnowledgeArtifactView(query.data),
    loading: query.isPending,
    readError: query.error,
    pending: current.pending,
    failure: current.failure,
    accept,
    refresh,
  };
}
