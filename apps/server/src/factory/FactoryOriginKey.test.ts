import { assert, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  feedItemOriginKey,
  issueOriginKey,
  knowledgeBriefOriginKey,
  researchRunOriginKey,
} from "./FactoryOriginKey.ts";

const github = SourceControlProviderKind.make("github");
const gitlab = SourceControlProviderKind.make("gitlab");

it.effect("origin keys escape delimiters and percent sequences without component collisions", () =>
  Effect.sync(() => {
    assert.equal(
      issueOriginKey(github, "github.com/owner/repo", 12),
      "github:github.com/owner/repo#12",
    );
    assert.equal(
      issueOriginKey(gitlab, "gitlab.com/group/subgroup/project", 12),
      "gitlab:gitlab.com/group/subgroup/project#12",
    );
    assert.notEqual(
      issueOriginKey(github, "forge.example/owner/repo", 12),
      issueOriginKey(gitlab, "forge.example/owner/repo", 12),
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
    assert.notEqual(issueOriginKey(github, "repo#12", 3), issueOriginKey(github, "repo%2312", 3));
    assert.equal(knowledgeBriefOriginKey("brief:1234"), "knowledge:brief%3A1234");
    assert.notEqual(knowledgeBriefOriginKey("a%3Ab"), knowledgeBriefOriginKey("a:b"));
    assert.equal(
      feedItemOriginKey("a%|#:", "b%|#:", "c%|#:"),
      "feed:a%25%7C%23%3A|b%25%7C%23%3A|c%25%7C%23%3A",
    );
  }),
);
