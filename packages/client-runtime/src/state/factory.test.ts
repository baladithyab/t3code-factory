import { describe, expect, it } from "@effect/vitest";

import { factoryIssueReviewText } from "./factory.ts";

describe("Factory source review text", () => {
  it("keeps full source, whitespace and HTML comments beyond row preview limits", () => {
    const source = `  <!-- task data -->\n${"x".repeat(65_536)}\n  `;
    expect(factoryIssueReviewText(source)).toBe(source);
  });

  it("preserves tabs and blank lines while exposing carriage returns", () => {
    expect(factoryIssueReviewText("\t A\r\n\n\n B \t")).toBe("\t A\\u000d\n\n\n B \t");
  });

  it("exposes bidi, astral formatting and lone surrogates without losing code units", () => {
    expect(factoryIssueReviewText("a\u202e\u{e0061}\ud800z")).toBe(
      "a\\u202e\\udb40\\udc61\\ud800z",
    );
  });

  it("distinguishes literal backslash escapes from actual hidden characters", () => {
    expect(factoryIssueReviewText("\\u202e\u202e")).toBe("\\\\u202e\\u202e");
  });
});
