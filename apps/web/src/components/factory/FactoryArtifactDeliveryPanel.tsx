import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  FactoryDeliveryPrepareInput,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { CircleDotIcon } from "lucide-react";
import { useContext, useEffect, useId, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  artifactDeliveryPrepareResult,
  artifactGrantDisabledReason,
  describeDeliveryStatus,
  factoryArtifactDeliveryFailure,
  isArtifactDeliveryIntent,
  isLiveFactoryDelivery,
  parseFactoryIssueNumber,
  type FactoryArtifactDeliveryFailure,
} from "./factoryDelivery.logic";
import { safeExternalUrl } from "./factoryIssues.logic";

function DeliveryFailure(props: { readonly failure: FactoryArtifactDeliveryFailure | null }) {
  if (props.failure === null) return null;
  // A tracker that cannot receive comments is a fact about the project, not something that broke.
  return props.failure.unsupported ? (
    <p role="status" className="text-muted-foreground text-xs">
      {props.failure.message}
    </p>
  ) : (
    <Alert variant="error">
      <AlertDescription>{props.failure.message}</AlertDescription>
    </Alert>
  );
}

/**
 * Publishes the accepted deliverable as one comment on an issue of the project's own repository.
 * The server renders the comment from the accepted bytes; this panel only shows it and grants it.
 */
export function FactoryArtifactDeliveryPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  /** The accepted digest still matches the file; only then can a comment be prepared or granted. */
  readonly acceptanceCurrent: boolean;
}) {
  const { environmentId, projectId, threadId, acceptanceCurrent } = props;
  const registry = useContext(RegistryContext);
  const headingId = useId();
  const issueId = useId();
  const disabledReasonId = useId();
  const reconcileReasonId = useId();
  const [issueText, setIssueText] = useState("");
  const [prepareInput, setPrepareInput] = useState<FactoryDeliveryPrepareInput | null>(null);
  const [failure, setFailure] = useState<FactoryArtifactDeliveryFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const deliveries = useEnvironmentQuery(
    factoryEnvironment.readDeliveries({ environmentId, input: { projectId, threadId } }),
  );
  const preview = useEnvironmentQuery(
    prepareInput === null
      ? null
      : factoryEnvironment.prepareDelivery({ environmentId, input: prepareInput }),
  );
  const hasGrantPermission = useAtomValue(
    factoryEnvironment.grantDelivery.permissionAtom(environmentId),
  );
  const hasReconcilePermission = useAtomValue(
    factoryEnvironment.reconcileDelivery.permissionAtom(environmentId),
  );
  const runGrant = useAtomCommand(factoryEnvironment.grantDelivery, {
    label: "factory grant artifact delivery",
    reportFailure: false,
  });
  const runReconcile = useAtomCommand(factoryEnvironment.reconcileDelivery, {
    label: "factory reconcile artifact delivery",
    reportFailure: false,
  });

  const issueNumber = parseFactoryIssueNumber(issueText);
  const prepared = prepareInput === null ? null : artifactDeliveryPrepareResult(preview.data);
  const intents = (deliveries.data?.intents ?? []).filter(isArtifactDeliveryIntent);
  // One live comment per destination: another issue's comment does not block this one.
  const existing =
    prepared === null
      ? null
      : (intents.find(
          (intent) =>
            intent.destinationKey === prepared.destinationKey && isLiveFactoryDelivery(intent),
        ) ?? prepared.existing);
  const prepareFailure =
    preview.error === null ? null : factoryArtifactDeliveryFailure(preview.failure, preview.error);
  const readFailure =
    deliveries.error === null
      ? null
      : factoryArtifactDeliveryFailure(deliveries.failure, deliveries.error);
  const visibleFailure = failure ?? prepareFailure ?? readFailure;
  const disabledReason = preview.isPending
    ? "Preparing the comment…"
    : (artifactGrantDisabledReason({
        acceptanceCurrent,
        existing,
        hasPermission: hasGrantPermission,
        prepared,
      }) ??
      (preview.error !== null || failure !== null
        ? "Prepare again before granting the comment."
        : deliveries.error !== null || deliveries.data === null || deliveries.isPending
          ? "Refresh delivery status before granting the comment."
          : null));
  const destinationHref = prepared === null ? null : safeExternalUrl(prepared.destination.url);

  const invalidatePreview = () => {
    // An edit must require a fresh server digest, even if the previous query is cached.
    setPrepareInput(null);
    setFailure(null);
  };
  const prepare = () => {
    if (busy || preview.isPending || !acceptanceCurrent || issueNumber === null) return;
    const input: FactoryDeliveryPrepareInput = {
      projectId,
      threadId,
      kind: "publish-artifact",
      payload: { issueNumber },
    };
    registry.refresh(factoryEnvironment.prepareDelivery({ environmentId, input }));
    setFailure(null);
    setPrepareInput(input);
  };

  const grant = async () => {
    if (inFlight.current || prepared === null || disabledReason !== null) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    const result = await runGrant({
      environmentId,
      input: {
        projectId,
        threadId,
        kind: "publish-artifact",
        commandId: randomUUID(),
        expectedArtifactSha256: prepared.artifactSha256,
        expectedPayloadDigest: prepared.payloadDigest,
        payload: prepared.payload,
      },
    }).finally(() => {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    });
    if (!mounted.current) return;
    if (result._tag === "Success") {
      setPrepareInput(null);
    } else if (!isAtomCommandInterrupted(result)) {
      setFailure(factoryArtifactDeliveryFailure(squashAtomCommandFailure(result)));
      deliveries.refresh();
    }
  };

  const reconcile = async (intentId: string) => {
    if (inFlight.current || !hasReconcilePermission) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    const result = await runReconcile({ environmentId, input: { projectId, intentId } }).finally(
      () => {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      },
    );
    if (!mounted.current) return;
    if (result._tag === "Success") {
      deliveries.refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      setFailure(factoryArtifactDeliveryFailure(squashAtomCommandFailure(result)));
    }
  };

  return (
    <section aria-labelledby={headingId} aria-busy={busy} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={headingId} className="font-medium text-sm">
          Publish as issue comment
        </h4>
        <Button
          size="xs"
          variant="outline"
          disabled={busy || deliveries.isPending}
          onClick={() => deliveries.refresh()}
          aria-label="Refresh delivery status"
        >
          Refresh
        </Button>
      </div>
      {acceptanceCurrent ? (
        <>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              prepare();
            }}
          >
            <div className="space-y-1">
              <label htmlFor={issueId} className="text-xs">
                Issue number
              </label>
              <Input
                id={issueId}
                value={issueText}
                inputMode="numeric"
                required
                disabled={busy || preview.isPending}
                onChange={(event) => {
                  setIssueText(event.target.value);
                  invalidatePreview();
                }}
              />
            </div>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={busy || preview.isPending || issueNumber === null}
            >
              {preview.isPending ? "Preparing…" : "Prepare"}
            </Button>
          </form>
          {prepared !== null && !preview.isPending && prepareFailure === null ? (
            <div className="min-w-0 space-y-2 rounded-lg border p-3">
              <dl className="space-y-1 text-xs [overflow-wrap:anywhere]">
                <div>
                  <dt>Destination</dt>
                  <dd className="flex flex-wrap items-center gap-2">
                    {destinationHref === null ? (
                      <span>
                        #{prepared.destination.number} {prepared.destination.title}
                      </span>
                    ) : (
                      <a
                        href={destinationHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-4"
                      >
                        #{prepared.destination.number} {prepared.destination.title}
                      </a>
                    )}
                    <Badge variant="outline">{prepared.destination.state}</Badge>
                  </dd>
                </div>
                <div>
                  <dt>Repository</dt>
                  <dd>{prepared.repository.canonicalKey}</dd>
                </div>
                <div>
                  <dt>Accepted artifact</dt>
                  <dd>
                    <code>{prepared.artifactSha256.slice(0, 7)}</code> ·{" "}
                    {prepared.artifactBytes.toLocaleString()} bytes
                  </dd>
                </div>
                <div>
                  <dt>Payload digest</dt>
                  <dd>
                    <code>{prepared.payloadDigest.slice(0, 7)}</code>
                  </dd>
                </div>
              </dl>
              {prepared.destination.state === "closed" ? (
                <Alert variant="warning">
                  <AlertDescription>
                    This issue is closed. The comment is still posted to it.
                  </AlertDescription>
                </Alert>
              ) : null}
              <p className="text-muted-foreground text-xs">
                The server rendered this comment from the accepted file. It is posted exactly as
                shown, and it cannot be edited here.
              </p>
              <pre
                tabIndex={0}
                aria-label="Comment body"
                className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border p-3 text-sm [overflow-wrap:anywhere]"
              >
                {prepared.body}
              </pre>
            </div>
          ) : null}
          <DeliveryFailure failure={visibleFailure} />
          <div className="space-y-1">
            <Button
              size="sm"
              disabled={busy || disabledReason !== null}
              aria-describedby={disabledReason === null ? undefined : disabledReasonId}
              onClick={() => void grant()}
            >
              Grant publish
            </Button>
            {disabledReason !== null ? (
              <p id={disabledReasonId} className="text-muted-foreground text-xs">
                {disabledReason}
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground text-xs">
            Accept the current artifact before publishing it as a comment.
          </p>
          <DeliveryFailure failure={failure ?? readFailure} />
        </>
      )}
      {deliveries.data === null && readFailure === null ? (
        <p role="status" className="text-muted-foreground text-xs">
          Reading deliveries…
        </p>
      ) : null}
      <ul aria-label="Comment deliveries" className="space-y-2 text-xs">
        {intents.map((intent) => {
          const href = intent.remote === null ? null : safeExternalUrl(intent.remote.url);
          const status = describeDeliveryStatus(intent, intent.repository.host);
          return (
            <li key={intent.id} className="space-y-1">
              <p className="[overflow-wrap:anywhere]">
                Issue #{intent.payload.issueNumber} · artifact{" "}
                <code>{intent.artifactSha256.slice(0, 7)}</code>
              </p>
              {intent.status === "pending" || intent.status === "sending" ? (
                <Badge variant="outline">
                  <CircleDotIcon />
                  {status}
                </Badge>
              ) : intent.status === "confirmed" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{status}</Badge>
                  {href !== null ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-4"
                    >
                      View comment
                    </a>
                  ) : null}
                </div>
              ) : (
                <p className="[overflow-wrap:anywhere]">{status}</p>
              )}
              {intent.status === "unknown" || intent.status === "failed" ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || !hasReconcilePermission}
                  aria-describedby={hasReconcilePermission ? undefined : reconcileReasonId}
                  onClick={() => void reconcile(intent.id)}
                >
                  Reconcile
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {!hasReconcilePermission &&
      intents.some((intent) => intent.status === "unknown" || intent.status === "failed") ? (
        <p id={reconcileReasonId} className="text-muted-foreground text-xs">
          Reconciling needs operate and source-control write permissions on this environment.
        </p>
      ) : null}
    </section>
  );
}
