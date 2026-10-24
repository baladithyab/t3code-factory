# Issue tracker: GitHub

Issues, specifications, research findings, and Wayfinder decisions live in `baladithyab/t3code-factory` on GitHub. Use `gh` with an explicit `--repo baladithyab/t3code-factory`; never publish factory planning to `pingdotgg/t3code`.

## Active records

- [Wayfinder: route to a combined software and research factory](https://github.com/baladithyab/t3code-factory/issues/2).
- [Factory inspiration sources and feature/parity review register](https://github.com/baladithyab/t3code-factory/issues/1).

Discover other maps with `gh issue list --repo baladithyab/t3code-factory --label wayfinder:map --state all`. These links are an index, not a copy of the plan.

## Conventions

- Create: `gh issue create --repo baladithyab/t3code-factory --title "..." --body-file <file>`.
- Read: `gh issue view <number> --repo baladithyab/t3code-factory --comments`.
- List: `gh issue list --repo baladithyab/t3code-factory --state open --json number,title,body,labels,assignees`.
- Comment: `gh issue comment <number> --repo baladithyab/t3code-factory --body-file <file>`.
- Label: `gh issue edit <number> --repo baladithyab/t3code-factory --add-label "..."`.
- Close: `gh issue close <number> --repo baladithyab/t3code-factory --comment "..."`.

Keep detailed decisions in their tickets and source/feature evidence in the linked reference register. Do not duplicate implementation plans or research notes in the repository. Refer to issues by linked title in handoffs.

## Pull requests as a triage surface

**PRs as a request surface: no.** Change this only after an explicit decision to treat external PRs as incoming requests.

## Wayfinding operations

Store each map in one issue labelled `wayfinder:map`. Create decision children with exactly one type label: `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`. A child's body contains only its `## Question`; use native relationships and comments for metadata and resolutions.

After creating all children, attach them to the map using GitHub sub-issues:

`gh api --method POST repos/baladithyab/t3code-factory/issues/<map>/sub_issues -F sub_issue_id=<child-database-id>`

Retrieve database IDs with `gh api repos/baladithyab/t3code-factory/issues/<number> --jq .id`.

Represent blocking edges using native issue dependencies:

`gh api --method POST repos/baladithyab/t3code-factory/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-database-id>`

If GitHub explicitly rejects a native relationship as unavailable, record `Part of [<map title>](<map URL>)` and `Blocked by: [<blocker title>](<blocker URL>)` in a metadata comment on the child. Maintain a linked child list in a map comment. Preserve the question-only child body.

Query children with `gh api repos/baladithyab/t3code-factory/issues/<map>/sub_issues --paginate`; inspect open children, assignees, and `issues/<child>/dependencies/blocked_by`. Frontier work is open, unblocked, and unassigned, in the map's recorded order. In fallback mode, use the map's child-index comment and the latest relationship metadata comments.

Claim before investigation: `gh issue edit <number> --repo baladithyab/t3code-factory --add-assignee @me`. Do not claim another person's work. Record a cited resolution comment, close the issue, and append a linked one-line pointer under the map's **Decisions so far**. Preserve concurrent edits when updating the map. Research may run in parallel; resolve no more than one non-research decision per session. Charting does not authorize implementation.
