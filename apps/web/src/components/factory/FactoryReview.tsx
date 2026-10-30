import { factoryIssueReviewText } from "@t3tools/client-runtime/state/factory";
import { useId } from "react";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

export interface FactoryReviewField {
  readonly label: string;
  readonly text: string | null;
  readonly emptyNote: string;
  /** Only fields that can be null need one; it falls back to the empty note. */
  readonly missingNote?: string;
}

/**
 * The inert, complete text a reviewer approves. Nothing is truncated, so what is confirmed is
 * exactly what the server will compare and freeze.
 */
export function FactoryReviewSnapshot(props: {
  readonly heading: string;
  readonly intro: string;
  readonly fields: ReadonlyArray<FactoryReviewField>;
}) {
  const reviewId = useId();
  return (
    <div className="space-y-2">
      <h3 id={`${reviewId}-title`} className="font-medium text-sm">
        {props.heading}
      </h3>
      <p id={`${reviewId}-description`} className="text-muted-foreground text-xs">
        {props.intro} Backslashes are escaped; control and formatting characters are shown as{" "}
        <code>{"\\uXXXX"}</code>. Tabs and newlines remain literal. No source text is omitted.
      </p>
      <div
        role="region"
        aria-labelledby={`${reviewId}-title`}
        aria-describedby={`${reviewId}-description`}
        tabIndex={0}
        className="max-h-80 min-w-0 space-y-3 overflow-auto rounded-lg border border-border/60 p-3 focus-visible:outline-2 focus-visible:outline-ring"
      >
        {props.fields.map((field) => {
          const text = field.text === null ? null : factoryIssueReviewText(field.text);
          return (
            <div key={field.label} className="space-y-1">
              <h4 className="font-medium text-xs">{field.label}</h4>
              {text === null ? (
                <p className="text-muted-foreground text-sm">
                  {field.missingNote ?? field.emptyNote}
                </p>
              ) : text.length === 0 ? (
                <p className="text-muted-foreground text-sm">{field.emptyNote}</p>
              ) : (
                <pre className="whitespace-pre-wrap font-sans text-sm [overflow-wrap:anywhere]">
                  {text}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Rendered outside the scrollable review panel so a disabled confirmation always has a visible
 * explanation beside it.
 */
export function FactoryReviewFailure(props: {
  readonly failure: { readonly title: string; readonly message: string };
  readonly changed: boolean;
  readonly staleHint: string;
}) {
  return (
    <div className="shrink-0 px-6 pt-3">
      <Alert variant="error">
        <AlertTitle>{props.failure.title}</AlertTitle>
        <AlertDescription>
          <p>{props.failure.message}</p>
          {props.changed ? <p>{props.staleHint}</p> : null}
        </AlertDescription>
      </Alert>
    </div>
  );
}
