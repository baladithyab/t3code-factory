import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  feedItemOriginKey,
  githubIssueOriginKey,
  knowledgeBriefOriginKey,
  researchRunOriginKey,
} from "./FactoryOriginKey.ts";

it.effect("origin keys escape delimiters and percent sequences without component collisions", () =>
  Effect.sync(() => {
    assert.equal(
      githubIssueOriginKey("github.com/owner/repo", 12),
      "github:github.com/owner/repo#12",
    );
    assert.equal(
      feedItemOriginKey("repo", "https://news/feed", "atom:X"),
      "feed:repo|https%3A//news/feed|atom%3AX",
    );
    assert.notEqual(
      feedItemOriginKey("repo|feed", "item", "X"),
      feedItemOriginKey("repo", "feed|item", "X"),
    );
    assert.notEqual(
      feedItemOriginKey("repo", "feed|item", "X"),
      feedItemOriginKey("repo", "feed", "item|X"),
    );
    assert.notEqual(
      researchRunOriginKey("p:explore", "verify"),
      researchRunOriginKey("p", "explore:verify"),
    );
    assert.notEqual(githubIssueOriginKey("repo#12", 3), githubIssueOriginKey("repo%2312", 3));
    assert.equal(knowledgeBriefOriginKey("brief:1234"), "knowledge:brief%3A1234");
    assert.notEqual(knowledgeBriefOriginKey("a%3Ab"), knowledgeBriefOriginKey("a:b"));
    assert.equal(
      feedItemOriginKey("a%|#:", "b%|#:", "c%|#:"),
      "feed:a%25%7C%23%3A|b%25%7C%23%3A|c%25%7C%23%3A",
    );
  }),
);
