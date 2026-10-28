import {
  FACTORY_DELIVERY_BODY_MAX_CHARS,
  FACTORY_DELIVERY_TITLE_MAX_CHARS,
  type EnvironmentId,
  type FactoryDeliveryIntent,
  type FactoryDeliveryPayload,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Linking, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import {
  factoryDeliveryDefaultPayload,
  factoryDeliveryGrantBlocker,
  factoryDeliveryStatusView,
  factoryRepositoryLabel,
  shortFactorySha,
} from "./factoryIssues";
import { useFactoryDelivery } from "./useFactoryIssueActions";

function DeliveryStatusRow(props: {
  readonly intent: FactoryDeliveryIntent;
  readonly busy: boolean;
  readonly canReconcile: boolean;
  readonly onReconcile: (intentId: string) => void;
}) {
  const view = factoryDeliveryStatusView(props.intent);
  // Static text while the server publishes: no spinner, so nothing repaints while it waits.
  if (view.kind === "confirmed" && view.url !== null) {
    const url = view.url;
    return (
      <Button
        tone="text"
        icon="arrow.up.right"
        label={`Open ${view.text}`}
        onPress={() => void Linking.openURL(url)}
      />
    );
  }
  return (
    <View className="gap-1">
      <Text
        selectable
        className={
          view.kind === "failed" || view.kind === "unknown"
            ? "text-sm text-danger-foreground"
            : "text-sm text-foreground"
        }
      >
        {view.text}
      </Text>
      {view.kind === "unknown" ? (
        <>
          <Button
            tone="secondary"
            label="Reconcile"
            accessibilityLabel="Reconcile with GitHub"
            accessibilityHint={
              props.canReconcile
                ? undefined
                : "This connection isn't permitted to reconcile in this environment."
            }
            loading={props.busy}
            disabled={props.busy || !props.canReconcile}
            onPress={() => props.onReconcile(props.intent.id)}
          />
          {props.canReconcile ? null : (
            <Text className="text-xs text-foreground-muted">
              This connection isn't permitted to reconcile in this environment.
            </Text>
          )}
        </>
      ) : null}
    </View>
  );
}

/**
 * Publishing a pull request for the accepted commit. The human previews the exact title, body,
 * head, and base, then grants that one preview; the server holds the forge credentials and does
 * the push. Nothing here retries on its own: a lost response is settled by an explicit
 * Reconcile, which reads GitHub and never creates.
 */
export function FactoryDeliverySection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly issue: { readonly number: number; readonly title: string; readonly url: string };
  readonly acceptedHeadSha: string | null;
  readonly acceptanceCurrent: boolean;
}) {
  const delivery = useFactoryDelivery(props);
  const [draft, setDraft] = useState<FactoryDeliveryPayload>(() =>
    factoryDeliveryDefaultPayload(props.issue),
  );
  if (!delivery.supported) return null;

  const { prepared, liveIntent } = delivery;
  const busy = delivery.pending || delivery.preparing;
  const blocker = factoryDeliveryGrantBlocker({
    permitted: delivery.canGrant,
    acceptedHeadSha: props.acceptedHeadSha,
    acceptanceCurrent: props.acceptanceCurrent,
    liveIntent,
    prepared,
    draft,
  });
  const prepareBlocker = !props.acceptanceCurrent
    ? "Publishing needs a current accepted commit."
    : draft.title.trim().length === 0
      ? "Add a title before preparing."
      : null;

  return (
    <View className="gap-2">
      <Text accessibilityRole="header" className="text-sm font-t3-semibold text-foreground">
        Pull request
      </Text>
      {delivery.deliveriesError ? (
        <Text className="text-sm text-foreground-muted">{delivery.deliveriesError}</Text>
      ) : null}
      {delivery.intents.map((intent) => (
        <DeliveryStatusRow
          key={intent.id}
          intent={intent}
          busy={delivery.pending}
          canReconcile={delivery.canReconcile}
          onReconcile={(intentId) => void delivery.reconcile(intentId)}
        />
      ))}
      {liveIntent === null ? (
        <>
          <AppTextInput
            accessibilityLabel="Pull request title"
            placeholder="Title"
            value={draft.title}
            maxLength={FACTORY_DELIVERY_TITLE_MAX_CHARS}
            editable={!delivery.pending}
            onChangeText={(title) => setDraft((current) => ({ ...current, title }))}
          />
          <AppTextInput
            accessibilityLabel="Pull request body"
            placeholder="Body"
            value={draft.body}
            multiline
            maxLength={FACTORY_DELIVERY_BODY_MAX_CHARS}
            textAlignVertical="top"
            className="min-h-24"
            editable={!delivery.pending}
            onChangeText={(body) => setDraft((current) => ({ ...current, body }))}
          />
          <View className="flex-row items-center gap-3">
            <Text className="min-w-0 flex-1 text-sm text-foreground">Open as draft</Text>
            <ThemedSwitch
              accessibilityLabel="Open as draft"
              value={draft.draft}
              disabled={delivery.pending}
              onValueChange={(value) => setDraft((current) => ({ ...current, draft: value }))}
            />
          </View>
          <Button
            fullWidth
            tone="secondary"
            label="Prepare"
            accessibilityLabel="Prepare pull request preview"
            accessibilityHint={prepareBlocker ?? undefined}
            loading={delivery.preparing}
            disabled={busy || prepareBlocker !== null}
            onPress={() => delivery.prepare(draft)}
          />
          {prepared ? (
            <Text selectable className="text-xs text-foreground-muted">
              {factoryRepositoryLabel(prepared.repository)} · head{" "}
              {shortFactorySha(prepared.headSha)} into {prepared.baseRef} · preview{" "}
              {prepared.payloadDigest.slice(0, 12)}
            </Text>
          ) : null}
          {delivery.previewFailure ? (
            <View accessibilityRole="alert" className="gap-1">
              <Text className="text-sm font-t3-semibold text-danger-foreground">
                {delivery.previewFailure.title}
              </Text>
              <Text selectable className="text-sm text-foreground">
                {delivery.previewFailure.detail}
              </Text>
            </View>
          ) : null}
          <Button
            fullWidth
            tone="primary"
            label="Grant publish"
            accessibilityLabel={
              prepared
                ? `Grant publish of head ${shortFactorySha(prepared.headSha)}`
                : "Grant publish"
            }
            accessibilityHint={blocker ?? undefined}
            loading={delivery.pending}
            disabled={busy || blocker !== null}
            onPress={() => void delivery.grant()}
          />
          {blocker ? <Text className="text-xs text-foreground-muted">{blocker}</Text> : null}
        </>
      ) : null}
      {delivery.failure ? (
        <View accessibilityRole="alert" accessibilityLiveRegion="polite" className="gap-1">
          <Text className="text-sm font-t3-semibold text-danger-foreground">
            {delivery.failure.title}
          </Text>
          <Text selectable className="text-sm text-foreground">
            {delivery.failure.detail}
          </Text>
        </View>
      ) : null}
      <Button
        tone="text"
        label="Refresh"
        accessibilityLabel="Refresh pull request status"
        disabled={busy || delivery.deliveriesLoading}
        onPress={delivery.refresh}
      />
    </View>
  );
}
