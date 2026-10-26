import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  resolveEffectiveDefaultModelSelection,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import type { ModelEsque } from "../chat/providerIconUtils";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { Alert, AlertDescription } from "../ui/alert";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export interface FactoryLaunchModelSettings {
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly defaultSelection: ModelSelection | null;
  readonly normalizeModelSelection: (selection: ModelSelection) => ModelSelection;
}

export function useFactoryLaunchModelSettings(
  environmentId: EnvironmentId,
  project: EnvironmentProject,
): FactoryLaunchModelSettings {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, project.id),
  );
  const normalizeModelSelection = (selection: ModelSelection) =>
    resolveEffectiveDefaultModelSelection(settings, providers, selection);
  const configuredDefault = scheduledTaskDefaultModel(settings, project, instanceEntries);
  const defaultSelection =
    configuredDefault === null ? null : normalizeModelSelection(configuredDefault);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    defaultSelection?.instanceId ?? null,
    defaultSelection?.model ?? null,
  );
  return { instanceEntries, modelOptionsByInstance, defaultSelection, normalizeModelSelection };
}

export interface FactoryLaunchDraft {
  readonly settings: FactoryLaunchModelSettings;
  readonly selection: ModelSelection | null;
  readonly activeInstanceId: ProviderInstanceId | null;
  readonly baseRef: string;
  readonly setBaseRef: (value: string) => void;
  readonly pick: (selection: ModelSelection) => void;
}

/** What the reviewer chose for one launch, with the defaults pinned while they review. */
export function useFactoryLaunchDraft(settings: FactoryLaunchModelSettings): FactoryLaunchDraft {
  const [pinned] = useState(() => settings);
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const [baseRef, setBaseRef] = useState("");
  const pickedIsAvailable =
    picked !== null &&
    pinned.instanceEntries.some((entry) => entry.instanceId === picked.instanceId && entry.enabled);
  const candidate = pickedIsAvailable ? picked : pinned.defaultSelection;
  const selection = candidate === null ? null : pinned.normalizeModelSelection(candidate);
  const activeInstanceId: ProviderInstanceId | null =
    selection?.instanceId ?? pinned.instanceEntries[0]?.instanceId ?? null;
  return { settings: pinned, selection, activeInstanceId, baseRef, setBaseRef, pick: setPicked };
}

/** Model, base ref and the fixed supervised mode, identical for every Factory task launch. */
export function FactoryLaunchFields(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly draft: FactoryLaunchDraft;
  /** Names the untrusted text in the supervised-mode notice, e.g. "Issue text". */
  readonly untrustedText: string;
  /**
   * Research runs and admissions start from a commit the protocol or finding already fixed, so a
   * base ref chosen here would be ignored; they hide the field instead of offering a dead control.
   */
  readonly showBaseRef?: boolean;
}) {
  const { draft } = props;
  return (
    <>
      <div className="space-y-1.5">
        <Label>Model</Label>
        <div>
          {draft.activeInstanceId !== null ? (
            <ProviderModelPicker
              environmentId={props.environmentId}
              disabled={props.disabled}
              activeInstanceId={draft.activeInstanceId}
              model={draft.selection?.model ?? ""}
              lockedProvider={null}
              instanceEntries={draft.settings.instanceEntries}
              modelOptionsByInstance={draft.settings.modelOptionsByInstance}
              isComposerOwned={false}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onInstanceModelChange={(instanceId, model) => draft.pick({ instanceId, model })}
            />
          ) : (
            <p className="text-muted-foreground text-sm">No provider is configured.</p>
          )}
        </div>
      </div>
      {props.showBaseRef !== false ? (
        <div className="space-y-1.5">
          <Label htmlFor="factory-base-ref">
            Base ref <span className="font-normal text-muted-foreground">optional</span>
          </Label>
          <Input
            id="factory-base-ref"
            value={draft.baseRef}
            placeholder="Current HEAD of the project checkout"
            onChange={(event) => draft.setBaseRef(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            A local branch, tag or commit. It is resolved to a fixed commit when the task starts;
            your checkout is not fetched or changed.
          </p>
        </div>
      ) : null}
      <Alert variant="info">
        <AlertDescription>
          The task starts with approval required. {props.untrustedText} is treated as untrusted task
          data, and nothing here authorizes publishing, merging or releasing. You can change the
          thread's controls afterwards.
        </AlertDescription>
      </Alert>
    </>
  );
}
