import { useAtomValue } from "@effect/atom-react";
import type {
  ModelSelection,
  ProjectCoordinator,
  ProjectCoordinatorEnsureInput,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { useId, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveEffectiveDefaultModelSelection,
} from "../../modelSelection";
import { isProviderInstancePickerReady, providerInstanceEntriesFor } from "../../providerInstances";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { getAntigravitySendBlockReason, resolveComposerInteractionMode } from "../ChatView.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { CoordinatorFailure } from "./factoryCoordinatorPresentation";

type CoordinatorModes = Pick<
  ProjectCoordinatorEnsureInput,
  "modelSelection" | "runtimeMode" | "interactionMode"
>;

export function FactoryOrchestratorDialog(props: {
  readonly target: SidebarProjectGroupMember;
  readonly environmentLabel: string;
  readonly coordinator: ProjectCoordinator | null;
  readonly request: ProjectCoordinatorEnsureInput | null;
  readonly canStart: boolean;
  readonly pending: boolean;
  readonly failure: CoordinatorFailure | null;
  readonly onClose: () => void;
  readonly onSubmit: (modes: CoordinatorModes) => void;
}) {
  const [target] = useState(props.target);
  const [reviewedCoordinator] = useState(props.coordinator);
  const id = useId();
  const resuming = reviewedCoordinator?.status === "launching";
  const replacing = reviewedCoordinator?.status === "missing";
  const frozen = props.request !== null;
  const locked = props.pending || frozen || resuming;
  const settings = useEnvironmentSettings(target.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(target.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, target.id);
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("approval-required");
  const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>("default");
  const [replacementConfirmed, setReplacementConfirmed] = useState(false);
  const candidate = resuming
    ? reviewedCoordinator.modelSelection
    : (picked ?? scheduledTaskDefaultModel(settings, target, entries));
  const selection =
    props.request?.modelSelection ??
    (candidate === null
      ? null
      : resuming
        ? candidate
        : resolveEffectiveDefaultModelSelection(settings, providers, candidate));
  const activeInstanceId =
    selection?.instanceId ?? entries.find((entry) => entry.enabled)?.instanceId ?? null;
  const entry = entries.find((candidateEntry) => candidateEntry.instanceId === activeInstanceId);
  const options = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    selection?.model ?? null,
  );
  const selectedRuntimeMode =
    props.request?.runtimeMode ?? (resuming ? reviewedCoordinator.runtimeMode : runtimeMode);
  const selectedInteractionMode =
    props.request?.interactionMode ??
    (resuming ? reviewedCoordinator.interactionMode : interactionMode);
  const supportedModes = entry?.snapshot.supportedRuntimeModes;
  const availableModes =
    supportedModes && supportedModes.length > 0
      ? runtimeModeOptions.filter((mode) => supportedModes.includes(mode))
      : runtimeModeOptions;
  const planEnabled = resolveComposerInteractionMode({
    planModeEnabled: settings.planModeEnabled,
    provider: entry?.snapshot,
    interactionMode: selectedInteractionMode,
  }).enabled;
  const providerBlock = getAntigravitySendBlockReason(entry?.snapshot, selection?.model ?? "");
  const modelOption =
    selection === null
      ? undefined
      : options.get(selection.instanceId)?.find((option) => option.slug === selection.model);
  const modelAvailable =
    selection !== null &&
    selection.model.trim().length > 0 &&
    entry !== undefined &&
    isProviderInstancePickerReady(entry) &&
    entry.snapshot.auth.status !== "unauthenticated" &&
    providerBlock === null &&
    modelOption?.isUnavailable !== true;
  const modeAvailable =
    availableModes.includes(selectedRuntimeMode) &&
    (selectedInteractionMode === "default" || planEnabled);
  const mayConfirm =
    props.canStart &&
    !props.pending &&
    !props.failure?.requiresReview &&
    (frozen || (modelAvailable && modeAvailable)) &&
    (!replacing || replacementConfirmed);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.pending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl" showCloseButton={!props.pending}>
        <DialogHeader>
          <DialogTitle>
            {resuming
              ? "Resume orchestrator start"
              : replacing
                ? "Replace unavailable orchestrator"
                : "Create and start orchestrator"}
          </DialogTitle>
          <DialogDescription>
            {resuming
              ? "Recover the original launch with its saved settings. This does not create another orchestrator or resend an accepted orientation."
              : "Creates a project thread and sends one read-only orientation request to the selected agent."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="min-w-0 space-y-4">
            <div className="min-w-0 space-y-1 rounded-lg border p-3 text-sm [overflow-wrap:anywhere]">
              <p className="font-medium">{target.title}</p>
              <p>{props.environmentLabel}</p>
              <p className="font-mono text-xs">{target.workspaceRoot}</p>
              <p className="text-muted-foreground text-xs">
                Runs in this checkout, not an isolated issue worktree.
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              The agent is asked to inspect project instructions, tracker and workflows when
              accessible, then wait. It is not asked to edit files, start workers, enable schedules,
              publish, merge or spend. Project text is context, not authority. This is an
              instruction, not a read-only sandbox; the selected provider and permission modes still
              apply.
            </p>
            <fieldset
              disabled={locked || props.failure?.requiresReview}
              className="min-w-0 space-y-4"
            >
              <div className="space-y-1.5" role="group" aria-label="Orchestrator model">
                <Label>Model</Label>
                {activeInstanceId !== null ? (
                  <ProviderModelPicker
                    environmentId={target.environmentId}
                    disabled={locked || props.failure?.requiresReview === true}
                    activeInstanceId={activeInstanceId}
                    model={selection?.model ?? ""}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={options}
                    isComposerOwned={false}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    triggerAriaLabel="Choose orchestrator provider and model"
                    onInstanceModelChange={(instanceId, model) => setPicked({ instanceId, model })}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">No provider is configured.</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-runtime`}>Permissions</Label>
                <Select
                  value={selectedRuntimeMode}
                  onValueChange={(value) => {
                    if (value !== null && availableModes.includes(value)) setRuntimeMode(value);
                  }}
                  disabled={locked || props.failure?.requiresReview}
                >
                  <SelectTrigger id={`${id}-runtime`} className="w-full">
                    <SelectValue>{runtimeModeConfig[selectedRuntimeMode].label}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {availableModes.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {runtimeModeConfig[mode].label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {runtimeModeConfig[selectedRuntimeMode].description} Connection mode limits remain
                  enforced by the server.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-interaction`}>Interaction</Label>
                <Select
                  value={selectedInteractionMode}
                  onValueChange={(value) => {
                    if (value === "default" || (value === "plan" && planEnabled))
                      setInteractionMode(value);
                  }}
                  disabled={locked || props.failure?.requiresReview}
                >
                  <SelectTrigger id={`${id}-interaction`} className="w-full">
                    <SelectValue>
                      {selectedInteractionMode === "plan" ? "Plan" : "Default"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="default">Default</SelectItem>
                    {planEnabled || selectedInteractionMode === "plan" ? (
                      <SelectItem value="plan" disabled={!planEnabled}>
                        Plan
                      </SelectItem>
                    ) : null}
                  </SelectPopup>
                </Select>
                {!planEnabled ? (
                  <p className="text-xs text-muted-foreground">
                    Plan mode is unavailable for this provider or disabled in settings.
                  </p>
                ) : null}
              </div>
            </fieldset>
            {!frozen && (!modelAvailable || !modeAvailable) ? (
              <Alert variant="warning">
                <AlertDescription>
                  {!modelAvailable
                    ? (providerBlock ??
                      "Choose a ready, signed-in provider and model before starting.")
                    : "The selected modes are not supported by this provider. Choose supported modes before starting."}
                </AlertDescription>
              </Alert>
            ) : null}
            {replacing ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  Replacing reviewed thread {reviewedCoordinator.threadId}. The server will reject a
                  stale binding.
                </p>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={replacementConfirmed}
                    disabled={props.pending || frozen}
                    onChange={(event) => setReplacementConfirmed(event.target.checked)}
                    className="mt-1 shrink-0"
                  />
                  <span>
                    I confirm a new orchestrator. Replacement does not move existing workflow
                    bindings or restore workflows removed when the old thread was deleted.
                  </span>
                </label>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Deleting an orchestrator thread also deletes workflows bound to it. Use the existing
                thread controls to archive instead.
              </p>
            )}
            {frozen ? (
              <p className="text-xs text-muted-foreground">
                Destination, model, modes and request ID are frozen. Retry recovers this same
                request; close to review a different request.
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <div className="shrink-0 px-6 py-3" aria-live="polite">
          {!props.canStart ? (
            <Alert variant="warning">
              <AlertDescription>
                The environment must be connected with orchestration operate permission before
                confirming.
              </AlertDescription>
            </Alert>
          ) : null}
          {props.failure ? (
            <Alert variant="error">
              <AlertTitle>{props.failure.title}</AlertTitle>
              <AlertDescription>{props.failure.message}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={props.pending} />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={!mayConfirm}
            aria-busy={props.pending}
            onClick={() => {
              if (!mayConfirm || selection === null) return;
              props.onSubmit({
                modelSelection: selection,
                runtimeMode: selectedRuntimeMode,
                interactionMode: selectedInteractionMode,
              });
            }}
          >
            {props.pending
              ? "Starting…"
              : frozen
                ? "Retry same request"
                : resuming
                  ? "Resume start"
                  : replacing
                    ? "Replace and start"
                    : "Create and start"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
