import type {
  EnvironmentId,
  FactoryKnowledgeArtifact,
  FactoryKnowledgeBrief,
  FactoryKnowledgeTask,
  ProjectId,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import {
  factoryTaskStatusLabel,
  factoryTaskStatusTone,
  safeFactoryIssueText,
} from "./factoryIssues";
import {
  factoryKnowledgeAction,
  factoryKnowledgePreview,
  formatFactoryBytes,
  shortFactoryDigest,
  type FactoryKnowledgeAction,
} from "./factoryKnowledge";
import { useFactoryKnowledgeTask } from "./useFactoryKnowledge";

const TASK_TONES = {
  active: { pillClassName: "bg-update", textClassName: "text-update-foreground" },
  neutral: { pillClassName: "bg-subtle", textClassName: "text-foreground-secondary" },
  danger: { pillClassName: "bg-danger", textClassName: "text-danger-foreground" },
} as const;

function taskTone(status: FactoryKnowledgeTask["status"]): StatusTone {
  return { label: factoryTaskStatusLabel(status), ...TASK_TONES[factoryTaskStatusTone(status)] };
}

function ArtifactDetails(props: { readonly artifact: FactoryKnowledgeArtifact }) {
  const { artifact } = props;
  const preview = factoryKnowledgePreview(artifact.preview);
  return (
    <View className="gap-2">
      <Text selectable className="text-sm text-foreground">
        {artifact.path}
      </Text>
      <Text selectable className="text-xs text-foreground-muted">
        sha256 {shortFactoryDigest(artifact.sha256)} · {formatFactoryBytes(artifact.bytes)} · read{" "}
        {new Date(artifact.observedAt).toLocaleString()}
      </Text>
      {preview === null ? (
        <Text className="text-xs text-foreground-muted">
          No text preview. The file is not UTF-8 text.
        </Text>
      ) : (
        <>
          <ScrollView
            nestedScrollEnabled
            style={{ maxHeight: 280 }}
            className="rounded-xl border border-border-subtle bg-subtle"
            contentContainerClassName="p-3"
          >
            <Text selectable className="font-mono text-xs text-foreground">
              {preview.text.length === 0 ? "The file is empty." : preview.text}
            </Text>
          </ScrollView>
          {preview.truncated ? (
            <Text className="text-xs text-foreground-muted">
              Preview shortened. Open the thread to read the whole file.
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

/**
 * Acceptance is a human decision about exact bytes. The section shows only what the last read
 * observed and accepts exactly that digest, so a rewritten artifact is refused, never pinned.
 * Mounted only while its row is expanded: each mount hashes the artifact on the server.
 */
function FactoryKnowledgeTaskSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly briefId: string;
}) {
  const task = useFactoryKnowledgeTask(props);
  if (!task.supported) return null;
  const { view, failure } = task;
  const permissionReason = task.canAccept
    ? null
    : "This connection isn't permitted to accept artifacts in this environment.";

  let content: ReactNode;
  if (view === null) {
    content = (
      <Text className="text-sm text-foreground-muted">
        {task.readError ?? "Reading the artifact…"}
      </Text>
    );
  } else if (view.kind === "none") {
    content =
      view.artifact === null ? (
        <Text className="text-sm text-foreground-muted">{view.unavailable}</Text>
      ) : (
        <>
          <Text className="text-sm text-foreground">No artifact accepted</Text>
          <ArtifactDetails artifact={view.artifact} />
          <Button
            fullWidth
            tone="primary"
            label="Accept this artifact"
            accessibilityLabel={`Accept artifact ${shortFactoryDigest(view.artifact.sha256)}`}
            accessibilityHint={permissionReason ?? undefined}
            loading={task.pending}
            disabled={permissionReason !== null}
            onPress={() => void task.accept(false)}
          />
          {permissionReason ? (
            <Text className="text-xs text-foreground-muted">{permissionReason}</Text>
          ) : null}
        </>
      );
  } else {
    const accepted = view.acceptance;
    content = (
      <>
        <View className="gap-1">
          <Text selectable className="text-sm text-foreground">
            Accepted sha256 {shortFactoryDigest(accepted.sha256)} ·{" "}
            {formatFactoryBytes(accepted.bytes)}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {new Date(accepted.acceptedAt).toLocaleString()}
          </Text>
        </View>
        {view.kind === "unverifiable" ? (
          <Text className="text-xs text-foreground-muted">
            {view.unavailable} Whether it changed since acceptance is unknown.
          </Text>
        ) : null}
        {view.kind === "current" ? <ArtifactDetails artifact={view.artifact} /> : null}
        {view.kind === "changed" ? (
          <>
            <View accessibilityRole="alert" className="gap-1">
              <Text className="text-sm font-t3-semibold text-danger-foreground">
                Artifact changed since acceptance
              </Text>
            </View>
            <ArtifactDetails artifact={view.artifact} />
            <Button
              fullWidth
              tone="primary"
              label="Re-accept"
              accessibilityLabel={`Re-accept artifact ${shortFactoryDigest(view.artifact.sha256)}`}
              accessibilityHint={permissionReason ?? undefined}
              loading={task.pending}
              disabled={permissionReason !== null}
              onPress={() => void task.accept(true)}
            />
            {permissionReason ? (
              <Text className="text-xs text-foreground-muted">{permissionReason}</Text>
            ) : null}
          </>
        ) : null}
      </>
    );
  }

  return (
    <View className="gap-2">
      <Text accessibilityRole="header" className="text-sm font-t3-semibold text-foreground">
        Artifact
      </Text>
      {content}
      {failure ? (
        <View accessibilityRole="alert" accessibilityLiveRegion="polite" className="gap-1">
          <Text className="text-sm font-t3-semibold text-danger-foreground">{failure.title}</Text>
          <Text selectable className="text-sm text-foreground">
            {failure.detail}
          </Text>
        </View>
      ) : null}
      <Button
        tone="text"
        label="Refresh"
        accessibilityLabel="Refresh artifact"
        disabled={task.pending || task.loading}
        onPress={task.refresh}
      />
    </View>
  );
}

/** One brief. Brief text is plain text from a person, never parsed as markup or links. */
export function FactoryBriefRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly brief: FactoryKnowledgeBrief;
  readonly task: FactoryKnowledgeTask | null;
  readonly busy: boolean;
  /** Another brief is being launched; starting is held until it settles. */
  readonly locked: boolean;
  readonly canStart: boolean;
  readonly borderTop: boolean;
  readonly onPerform: (brief: FactoryKnowledgeBrief, action: FactoryKnowledgeAction) => void;
}) {
  const { brief, task } = props;
  const [expanded, setExpanded] = useState(false);
  const action = factoryKnowledgeAction(brief, task);
  const title = safeFactoryIssueText(brief.title, 240) || "Untitled brief";
  const needsStart =
    action.kind === "start" || action.kind === "resume" || action.kind === "restart";
  const disabled = props.busy || (needsStart && (!props.canStart || props.locked));
  const superseded = brief.supersededBy !== null;

  return (
    <View className={props.borderTop ? "border-t border-border-subtle" : undefined}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Brief ${title}, revision ${shortFactoryDigest(brief.revision)}${
          superseded ? ", superseded" : ""
        }${task ? `, ${factoryTaskStatusLabel(task.status)}` : ", not started"}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        className="gap-2 px-4 py-3 active:opacity-70"
      >
        <View className="flex-row items-start gap-3">
          <Text
            className="min-w-0 flex-1 text-base font-t3-medium text-foreground"
            numberOfLines={expanded ? undefined : 2}
          >
            {title}
          </Text>
          <SymbolView
            name={expanded ? "chevron.up" : "chevron.down"}
            size={14}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
        </View>
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="text-sm text-foreground-muted">
            rev {shortFactoryDigest(brief.revision)}
          </Text>
          {superseded ? (
            <StatusPill
              size="compact"
              label="Superseded"
              pillClassName="bg-subtle"
              textClassName="text-foreground-secondary"
            />
          ) : null}
          {task ? (
            <StatusPill size="compact" {...taskTone(task.status)} />
          ) : (
            <Text className="text-sm text-foreground-muted">Not started</Text>
          )}
        </View>
      </Pressable>
      {expanded ? (
        <View className="gap-3 px-4 pb-4">
          <Text selectable className="text-sm leading-normal text-foreground-secondary">
            {safeFactoryIssueText(brief.question) || "No question."}
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            Deliverable {brief.deliverablePath} · {brief.inputs.length}{" "}
            {brief.inputs.length === 1 ? "input" : "inputs"} · created{" "}
            {new Date(brief.createdAt).toLocaleString()}
          </Text>
          {task ? (
            <Text className="text-xs text-foreground-muted">
              Task started {new Date(task.createdAt).toLocaleString()}
            </Text>
          ) : null}
          {action.kind === "unavailable" ? (
            <Text className="text-sm text-foreground-muted">{action.detail}</Text>
          ) : (
            <Button
              label={action.label}
              tone={action.kind === "open" ? "secondary" : "primary"}
              accessibilityLabel={`${action.label} for brief ${title}`}
              loading={props.busy}
              disabled={disabled}
              onPress={() => props.onPerform(brief, action)}
            />
          )}
          {task !== null ? (
            // Kept for a deleted thread too, so an earlier acceptance stays visible.
            <FactoryKnowledgeTaskSection
              environmentId={props.environmentId}
              projectId={props.projectId}
              briefId={brief.id}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
