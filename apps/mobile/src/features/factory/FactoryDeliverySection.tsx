import {
  FACTORY_DELIVERY_BODY_MAX_CHARS,
  FACTORY_DELIVERY_TITLE_MAX_CHARS,
  type EnvironmentId,
  type FactoryDeliveryIntent,
  type FactoryDeliveryPublishPayload,
  type ProjectId,
  type PullRequestMergeMethod,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Linking, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import {
  FACTORY_DEFAULT_MERGE_METHOD,
  FACTORY_MERGE_METHODS,
  factoryDeliveryDefaultPayload,
  factoryDeliveryGrantBlocker,
  factoryDeliveryStatusView,
  factoryMergeabilityLabel,
  factoryMergeGrantBlocker,
  factoryPullRequestHeadView,
  factoryRepositoryLabel,
  safeFactoryIssueUrl,
  shortFactorySha,
  type FactoryFailure,
} from "./factoryIssues";
import { useFactoryDelivery } from "./useFactoryIssueActions";

function DeliveryStatusRow(props: {
  readonly intent: FactoryDeliveryIntent;
  readonly busy: boolean;
  readonly canReconcile: boolean;
  readonly onReconcile: (intent: FactoryDeliveryIntent) => void;
}) {
  const view = factoryDeliveryStatusView(props.intent);
  const link = view.kind === "confirmed" ? view.link : null;
  // Static text while the server publishes or merges: no spinner, so nothing repaints while it
  // waits.
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
      {link !== null ? (
        <Button
          tone="text"
          icon="arrow.up.right"
          label={link.label}
          onPress={() => void Linking.openURL(link.url)}
        />
      ) : null}
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
            onPress={() => props.onReconcile(props.intent)}
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

function FailureNotice(props: { readonly failure: FactoryFailure; readonly live?: boolean }) {
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion={props.live ? "polite" : undefined}
      className="gap-1"
    >
      <Text className="text-sm font-t3-semibold text-danger-foreground">{props.failure.title}</Text>
      <Text selectable className="text-sm text-foreground">
        {props.failure.detail}
      </Text>
    </View>
  );
}

type Delivery = ReturnType<typeof useFactoryDelivery>;

/**
 * Merging the published pull request. A separate single-use grant over the exact pull request
 * head the human was shown; the server pins GitHub's merge to that head, so a push after review
 * is refused rather than merged. GitHub branch protection still owns required checks and
 * reviews: this only shows them, it never decides them.
 */
function MergeSection(props: {
  readonly delivery: Delivery;
  readonly acceptedHeadSha: string | null;
  readonly acceptanceCurrent: boolean;
}) {
  const { delivery } = props;
  // Allowed methods are only known after a prepare; until then every method is offered and the
  // blocker names a disabled one once the host has answered.
  const [mergeMethod, setMergeMethod] = useState<PullRequestMergeMethod>(
    FACTORY_DEFAULT_MERGE_METHOD,
  );
  const { mergePrepared: prepared, liveMergeIntent: liveIntent } = delivery;
  const busy = delivery.pending || delivery.mergePreparing;
  const blocker = factoryMergeGrantBlocker({
    permitted: delivery.canGrant,
    acceptedHeadSha: props.acceptedHeadSha,
    acceptanceCurrent: props.acceptanceCurrent,
    liveIntent,
    prepared,
    mergeMethod,
  });
  const prepareBlocker = props.acceptanceCurrent
    ? null
    : "Merging needs a current accepted commit.";
  const pullRequest = prepared?.pullRequest ?? null;
  const pullRequestUrl = pullRequest === null ? null : safeFactoryIssueUrl(pullRequest.url);
  const head =
    pullRequest === null ? null : factoryPullRequestHeadView(pullRequest, props.acceptedHeadSha);

  return (
    <View className="gap-2">
      <Text accessibilityRole="header" className="text-sm font-t3-semibold text-foreground">
        Merge
      </Text>
      {delivery.mergeIntents.map((intent) => (
        <DeliveryStatusRow
          key={intent.id}
          intent={intent}
          busy={delivery.pending}
          canReconcile={delivery.canReconcile}
          onReconcile={(target) => void delivery.reconcile(target)}
        />
      ))}
      {liveIntent === null ? (
        <>
          <SegmentedControl
            options={FACTORY_MERGE_METHODS.filter(
              (option) =>
                prepared?.pullRequest == null ||
                prepared.pullRequest.mergeMethods.includes(option.value),
            )}
            selected={mergeMethod}
            onSelect={setMergeMethod}
          />
          <Button
            fullWidth
            tone="secondary"
            label="Prepare"
            accessibilityLabel="Prepare merge preview"
            accessibilityHint={prepareBlocker ?? undefined}
            loading={delivery.mergePreparing}
            disabled={busy || prepareBlocker !== null}
            onPress={() => delivery.prepareMerge(mergeMethod)}
          />
          {pullRequest !== null && head !== null ? (
            <View className="gap-1">
              {pullRequestUrl === null ? (
                <Text selectable className="text-sm text-foreground">
                  Pull request #{pullRequest.number}
                </Text>
              ) : (
                <Button
                  tone="text"
                  icon="arrow.up.right"
                  label={`Open pull request #${pullRequest.number}`}
                  onPress={() => void Linking.openURL(pullRequestUrl)}
                />
              )}
              <Text
                selectable
                className={
                  head.matches ? "text-sm text-foreground" : "text-sm text-danger-foreground"
                }
              >
                {head.text}
              </Text>
              <Text
                className={
                  pullRequest.mergeability === "conflicting"
                    ? "text-sm text-danger-foreground"
                    : "text-sm text-foreground"
                }
              >
                {factoryMergeabilityLabel(pullRequest.mergeability)}
              </Text>
              {pullRequest.isDraft ? (
                <Text className="text-sm text-danger-foreground">
                  This pull request is a draft.
                </Text>
              ) : null}
              <Text selectable className="text-sm text-foreground-muted">
                Checks: {pullRequest.checksSummary ?? "none reported"}
              </Text>
              {prepared ? (
                <Text selectable className="text-xs text-foreground-muted">
                  Preview {prepared.payloadDigest.slice(0, 12)}
                </Text>
              ) : null}
            </View>
          ) : null}
          {delivery.mergePreviewFailure ? (
            <FailureNotice failure={delivery.mergePreviewFailure} />
          ) : null}
          <Button
            fullWidth
            tone="primary"
            label="Grant merge"
            accessibilityLabel={
              pullRequest ? `Grant merge of pull request #${pullRequest.number}` : "Grant merge"
            }
            accessibilityHint={blocker ?? undefined}
            loading={delivery.pending}
            disabled={busy || blocker !== null}
            onPress={() => void delivery.grantMerge()}
          />
          {blocker ? <Text className="text-xs text-foreground-muted">{blocker}</Text> : null}
        </>
      ) : null}
      {delivery.mergeFailure ? <FailureNotice failure={delivery.mergeFailure} live /> : null}
    </View>
  );
}

/**
 * Publishing a pull request for the accepted commit, then merging it. The human previews the
 * exact title, body, head, and base, then grants that one preview; the server holds the forge
 * credentials and does the push and the merge. Nothing here retries on its own: a lost response
 * is settled by an explicit Reconcile, which reads GitHub and never creates or merges.
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
  const [draft, setDraft] = useState<FactoryDeliveryPublishPayload>(() =>
    factoryDeliveryDefaultPayload(props.issue),
  );
  if (!delivery.supported) return null;

  const { prepared, liveIntent } = delivery;
  const busy = delivery.pending || delivery.preparing || delivery.mergePreparing;
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
      {delivery.publishIntents.map((intent) => (
        <DeliveryStatusRow
          key={intent.id}
          intent={intent}
          busy={delivery.pending}
          canReconcile={delivery.canReconcile}
          onReconcile={(target) => void delivery.reconcile(target)}
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
          {delivery.previewFailure ? <FailureNotice failure={delivery.previewFailure} /> : null}
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
      {delivery.failure ? <FailureNotice failure={delivery.failure} live /> : null}
      {delivery.published ? (
        <MergeSection
          delivery={delivery}
          acceptedHeadSha={props.acceptedHeadSha}
          acceptanceCurrent={props.acceptanceCurrent}
        />
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
