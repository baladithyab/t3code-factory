import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useId, useState } from "react";

import { useNowSecond } from "../../hooks/useNowSecond";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { RelativeTime } from "../RelativeTime";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import {
  describeFactoryFailure,
  factoryFrontierPresentation,
  type FactoryReadinessTone,
} from "./factoryIssues.logic";

const VERDICT_BADGE_VARIANT = {
  success: "success",
  warning: "warning",
  info: "info",
  neutral: "secondary",
} as const satisfies Record<FactoryReadinessTone, "success" | "warning" | "info" | "secondary">;

/**
 * A collapsed-by-default view of one issue's native sub-issues. Nothing is read until it is
 * opened, and only the Refresh button reads again. It lists the tracker's own order with each
 * child's observed verdict; it never picks a next issue, orders work or starts anything.
 */
export function FactoryIssueFrontier(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly issueNumber: number;
  readonly displayName: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="mt-4 space-y-2 border-border/60 border-t pt-3">
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${open ? "Hide" : "Show"} sub-issues of issue #${props.issueNumber}`}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDownIcon className={open ? "rotate-180" : undefined} />
        Sub-issues
      </Button>
      {open ? (
        <FactoryIssueFrontierPanel
          id={panelId}
          environmentId={props.environmentId}
          projectId={props.projectId}
          issueNumber={props.issueNumber}
          displayName={props.displayName}
        />
      ) : null}
    </div>
  );
}

/** Mounts only while open, so the read happens once per open and again only on Refresh. */
function FactoryIssueFrontierPanel(props: {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly issueNumber: number;
  readonly displayName: string;
}) {
  const nowMs = useNowSecond();
  const query = useEnvironmentQuery(
    factoryEnvironment.readIssueFrontier({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, parentIssueNumber: props.issueNumber },
    }),
  );
  const failure =
    query.error === null
      ? null
      : describeFactoryFailure(query.failure, query.error, props.displayName);
  const presentation =
    failure === null && query.data !== null
      ? factoryFrontierPresentation(query.data, nowMs, props.displayName)
      : null;
  const refreshing = query.isPending;

  return (
    <div id={props.id} aria-busy={refreshing} className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          {query.data !== null && failure === null ? (
            <>
              Observed <RelativeTime timestamp={query.data.observedAt} />
              {presentation?.stale ? " · stale" : null}
            </>
          ) : null}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={query.refresh}
          disabled={refreshing}
          aria-label={`Refresh sub-issues for issue #${props.issueNumber}`}
        >
          <RefreshIcon size="sm" refreshing={refreshing} />
          Refresh
        </Button>
      </div>
      {failure !== null ? (
        <Alert variant="error">
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      ) : presentation === null ? (
        <p className="text-muted-foreground text-sm" role="status">
          Observing sub-issues…
        </p>
      ) : (
        <>
          {presentation.note !== null ? (
            <Alert variant="warning">
              <AlertDescription>{presentation.note}</AlertDescription>
            </Alert>
          ) : null}
          {presentation.rows.length === 0 ? (
            presentation.note === null ? (
              <p className="text-muted-foreground text-sm">This issue has no sub-issues.</p>
            ) : null
          ) : (
            <Table>
              <caption className="sr-only">
                Sub-issues of issue #{props.issueNumber}, in {props.displayName}'s order
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Sub-issue</TableHead>
                  <TableHead scope="col">Title</TableHead>
                  <TableHead scope="col">Verdict</TableHead>
                  <TableHead scope="col">Assignees</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {presentation.rows.map((row) => (
                  <TableRow key={row.key}>
                    <TableCell>
                      {row.url !== null ? (
                        <a
                          href={row.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline-offset-4 hover:underline"
                        >
                          #{row.number}
                        </a>
                      ) : (
                        `#${row.number}`
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="min-w-40 max-w-96 whitespace-normal [overflow-wrap:anywhere]">
                        {row.title}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={VERDICT_BADGE_VARIANT[row.tone]}>{row.verdictLabel}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="max-w-56 whitespace-normal [overflow-wrap:anywhere]">
                        {row.assigneesLabel}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="text-muted-foreground text-xs">
            Read from {props.displayName}'s sub-issue list in its own order. Evidence only: it does
            not pick, order or start work, and assignees are shown but never counted. Refresh
            observes again.
          </p>
        </>
      )}
    </div>
  );
}
