import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useMemo, useState } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { groupByProvider } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { useDebouncedValue, usePaginatedBranches } from "../../state/queries";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { BranchPickerScreen } from "../threads/NewTaskContextPickerScreens";
import { ThreadSettingsPickerScreen } from "../threads/ThreadSettingsSheet";
import { updateFactoryInboxSelection, useFactoryInboxSelection } from "./factory-inbox-state";
import { useFactoryLaunchModel } from "./useFactoryLaunch";

function MissingInboxSelection() {
  return (
    <SettingsScreen title="Factory issues">
      <Text className="p-5 text-base text-foreground-muted">
        Choose a project in the issue inbox first.
      </Text>
    </SettingsScreen>
  );
}

export function FactoryModelPickerRouteScreen() {
  const navigation = useNavigation();
  const selection = useFactoryInboxSelection();
  const launch = useFactoryLaunchModel(selection);
  const providerGroups = useMemo(() => groupByProvider(launch.modelOptions), [launch.modelOptions]);
  const optionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: launch.option?.capabilities,
        selections: launch.modelSelection?.options,
      }),
    [launch.option?.capabilities, launch.modelSelection?.options],
  );

  if (selection.environmentId === null || selection.projectId === null) {
    return <MissingInboxSelection />;
  }

  return (
    <ThreadSettingsPickerScreen
      environmentId={selection.environmentId}
      projectId={selection.projectId}
      providerGroups={providerGroups}
      selectedModel={launch.modelSelection}
      // Issue tasks start from the issue itself, so there is no composer prompt to steer traits.
      prompt=""
      onPromptChange={() => {}}
      onSelectModel={(option) => updateFactoryInboxSelection({ modelSelection: option.selection })}
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={(options) => {
        if (launch.modelSelection)
          updateFactoryInboxSelection({ modelSelection: { ...launch.modelSelection, options } });
      }}
      runtimeMode={selection.runtimeMode}
      onUpdateRuntimeMode={(runtimeMode) => updateFactoryInboxSelection({ runtimeMode })}
      onClose={() => navigation.goBack()}
    />
  );
}

export function FactoryBranchPickerRouteScreen() {
  const navigation = useNavigation();
  const selection = useFactoryInboxSelection();
  const launch = useFactoryLaunchModel(selection);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 150);
  const branches = usePaginatedBranches({
    environmentId: selection.environmentId,
    cwd: launch.project?.workspaceRoot ?? null,
    query: debouncedQuery,
  });

  if (selection.environmentId === null || selection.projectId === null) {
    return <MissingInboxSelection />;
  }

  // The server resolves the base from a local ref, so remote-tracking names would be rejected.
  const visibleBranches = branches.refs.filter(
    (branch) => !branch.isRemote && branch.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <BranchPickerScreen
      title="Base branch"
      project={launch.project}
      branches={visibleBranches}
      selectedBranchName={selection.baseRef}
      query={query}
      onQueryChange={setQuery}
      loading={
        query.trim() !== debouncedQuery.trim() || (branches.isPending && branches.data === null)
      }
      error={launch.project ? branches.error : "This project is no longer available."}
      refreshing={branches.isFetchingNextPage}
      hasMore={branches.data?.nextCursor != null}
      onRefresh={branches.refresh}
      onLoadMore={branches.loadNext}
      onSelect={(branch) => {
        void Haptics.selectionAsync();
        updateFactoryInboxSelection({ baseRef: branch.name });
        navigation.goBack();
      }}
    />
  );
}
