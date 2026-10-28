import type { EnvironmentId, FactoryIssue } from "@t3tools/contracts";
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";

import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { FactoryAcceptedCommitSection } from "./FactoryAcceptedCommitSection";
import {
  factoryIssueAction,
  factoryTaskStatusLabel,
  factoryTaskStatusTone,
  safeFactoryIssueBody,
  safeFactoryIssueText,
  safeFactoryIssueUrl,
  type FactoryIssueAction,
} from "./factoryIssues";

const TASK_TONES = {
  active: {
    pillClassName: "bg-update",
    textClassName: "text-update-foreground",
  },
  neutral: {
    pillClassName: "bg-subtle",
    textClassName: "text-foreground-secondary",
  },
  danger: {
    pillClassName: "bg-danger",
    textClassName: "text-danger-foreground",
  },
} as const;

function taskTone(status: NonNullable<FactoryIssue["task"]>["status"]): StatusTone {
  return { label: factoryTaskStatusLabel(status), ...TASK_TONES[factoryTaskStatusTone(status)] };
}

/**
 * One issue. Everything from GitHub is plain text: titles, labels, and the body are never parsed
 * as markup, so an issue cannot style the screen or smuggle a link into it.
 */
export function FactoryIssueRow(props: {
  readonly environmentId: EnvironmentId;
  readonly issue: FactoryIssue;
  readonly busy: boolean;
  /** Another issue is being launched; starting is held until it settles. */
  readonly locked: boolean;
  readonly canStart: boolean;
  readonly canOpen: boolean;
  readonly onPerform: (issue: FactoryIssue, action: FactoryIssueAction) => void;
  readonly borderTop: boolean;
}) {
  const { issue } = props;
  const [expanded, setExpanded] = useState(false);
  const action = factoryIssueAction(issue);
  const body = expanded ? safeFactoryIssueBody(issue.body) : null;
  const url = expanded ? safeFactoryIssueUrl(issue.url) : null;
  const title = safeFactoryIssueText(issue.title, 240) || `Issue #${issue.number}`;
  const needsStart =
    action.kind === "start" || action.kind === "resume" || action.kind === "restart";
  const disabled =
    props.busy ||
    (needsStart && (!props.canStart || props.locked)) ||
    (action.kind === "open" && !props.canOpen);

  return (
    <View className={props.borderTop ? "border-t border-border-subtle" : undefined}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Issue ${issue.number}, ${title}, ${issue.state}${
          issue.task ? `, ${factoryTaskStatusLabel(issue.task.status)}` : ""
        }`}
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
          <Text className="text-sm text-foreground-muted">#{issue.number}</Text>
          {issue.state === "closed" ? (
            <StatusPill
              size="compact"
              label="Closed"
              pillClassName="bg-subtle"
              textClassName="text-foreground-secondary"
            />
          ) : null}
          {issue.task ? <StatusPill size="compact" {...taskTone(issue.task.status)} /> : null}
          {issue.labels.slice(0, expanded ? undefined : 3).map((label) => (
            <Text key={label} className="text-xs text-foreground-muted" numberOfLines={1}>
              {safeFactoryIssueText(label, 40)}
            </Text>
          ))}
        </View>
      </Pressable>
      {expanded ? (
        <View className="gap-3 px-4 pb-4">
          <Text className="text-xs text-foreground-muted">
            Issue preview. New tasks require review of the complete title and body.
          </Text>
          {body ? (
            <Text selectable className="text-sm leading-normal text-foreground-secondary">
              {body}
            </Text>
          ) : (
            <Text className="text-sm text-foreground-muted">No description.</Text>
          )}
          {issue.task ? (
            <Text className="text-xs text-foreground-muted" selectable>
              Base {issue.task.baseRef.slice(0, 12)} · started{" "}
              {new Date(issue.task.createdAt).toLocaleString()}
            </Text>
          ) : null}
          {action.kind === "open" ? (
            // Mounted only while expanded: each mount reads the worktree head on the server.
            <FactoryAcceptedCommitSection
              environmentId={props.environmentId}
              projectId={action.task.projectId}
              threadId={action.task.threadId}
              issue={issue}
            />
          ) : null}
          {action.kind === "unavailable" ? (
            <Text className="text-sm text-foreground-muted">{action.detail}</Text>
          ) : (
            <Button
              label={action.label}
              tone={action.kind === "open" ? "secondary" : "primary"}
              accessibilityLabel={`${action.label} for issue ${issue.number}`}
              loading={props.busy}
              disabled={disabled}
              onPress={() => props.onPerform(issue, action)}
            />
          )}
          {url ? (
            <Button
              label="View on GitHub"
              tone="text"
              icon="arrow.up.right"
              onPress={() => void Linking.openURL(url)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
