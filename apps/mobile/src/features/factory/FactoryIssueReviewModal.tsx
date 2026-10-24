import type { RuntimeMode } from "@t3tools/contracts";
import { Modal, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { FACTORY_SUPERVISION_NOTICE, factoryRepositoryLabel } from "./factoryIssues";
import type { FactoryIssueReview } from "./useFactoryIssueActions";

const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Approval required",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export function FactoryIssueReviewModal(props: {
  readonly review: FactoryIssueReview;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { snapshot, failure } = props.review;
  const { input } = snapshot.request;
  const restart = input.restartDeleted === true;
  const changed = failure?.kind === "changed";

  return (
    <Modal
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={props.onClose}
    >
      <View
        className="flex-1 bg-sheet-solid"
        accessibilityViewIsModal
        onAccessibilityEscape={props.onClose}
        style={{
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        }}
      >
        <SheetHeader
          presentation="inline"
          title="Review issue"
          accessibilityLabel="Close issue review"
          dismissDisabled={props.pending}
          onClose={props.onClose}
        />
        <ScrollView className="min-h-0 flex-1" contentContainerClassName="gap-5 px-5 py-4">
          <View className="gap-2">
            <Text accessibilityRole="header" className="text-xl font-t3-semibold text-foreground">
              {restart ? "Start a new attempt" : "Start task"} for issue #{snapshot.issue.number}
            </Text>
            <Text selectable className="text-base text-foreground">
              Repository: {factoryRepositoryLabel(snapshot.repository)}
            </Text>
            <Text className="text-sm text-foreground-muted">
              {restart
                ? "The earlier thread was deleted. A new attempt creates a new isolated worktree."
                : "This creates an isolated worktree for the issue."}
            </Text>
          </View>
          <View className="gap-2">
            <Text selectable className="text-base text-foreground">
              Model: {snapshot.modelLabel}
            </Text>
            <Text selectable className="text-base text-foreground">
              Base: {input.baseRef ?? "Current HEAD"}
            </Text>
            <Text className="text-base text-foreground">
              Runtime: {RUNTIME_MODE_LABELS[input.runtimeMode]}
            </Text>
            <Text className="text-sm text-foreground-muted">{FACTORY_SUPERVISION_NOTICE}</Text>
            <Text className="text-sm text-foreground-muted">
              Confirm uses this issue snapshot and these settings. If a task was already reserved,
              its saved content and settings are used instead.
            </Text>
          </View>
          <Text className="text-sm text-foreground-muted">
            {
              "Backslashes are escaped; control and formatting characters are shown as \\uXXXX. Tabs and newlines stay literal; no source text is omitted."
            }
          </Text>
          <View className="gap-2">
            <Text accessibilityRole="header" className="text-base font-t3-semibold text-foreground">
              Full issue title
            </Text>
            <Text selectable className="text-base text-foreground">
              {snapshot.titleText}
            </Text>
          </View>
          <View className="gap-2">
            <Text accessibilityRole="header" className="text-base font-t3-semibold text-foreground">
              Full issue body
            </Text>
            {snapshot.bodyText === null ? (
              <Text className="text-sm text-foreground-muted">No body was provided.</Text>
            ) : snapshot.bodyText === "" ? (
              <Text className="text-sm text-foreground-muted">The issue body is empty.</Text>
            ) : (
              <Text selectable className="text-base text-foreground">
                {snapshot.bodyText}
              </Text>
            )}
          </View>
        </ScrollView>
        <ScrollView
          className="border-t border-border-subtle"
          style={{ flexGrow: 0, maxHeight: "45%" }}
          contentContainerClassName="gap-3 px-5 py-4"
        >
          {failure ? (
            <View accessibilityRole="alert" accessibilityLiveRegion="polite" className="gap-1">
              <Text className="text-base font-t3-semibold text-danger-foreground">
                {failure.title}
              </Text>
              <Text selectable className="text-sm text-foreground">
                {failure.detail}
              </Text>
              {changed ? (
                <Text className="text-sm text-foreground">
                  Close this review and reopen the issue from the refreshed inbox before starting.
                </Text>
              ) : null}
            </View>
          ) : null}
          <Button
            fullWidth
            tone="primary"
            label={restart ? "Start new attempt" : "Start task"}
            accessibilityLabel={`${restart ? "Start new attempt" : "Start task"} for reviewed issue ${snapshot.issue.number}`}
            loading={props.pending}
            disabled={changed}
            onPress={props.onConfirm}
          />
        </ScrollView>
      </View>
    </Modal>
  );
}
