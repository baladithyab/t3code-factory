# Domain documentation

## Read before work

Read `.pi-flow/CONTEXT.md` for the shared factory vocabulary. Read relevant `.pi-flow/docs/adr/` entries if present. Do not create empty ADR records.

## Layout

Use one project-wide `.pi-flow/CONTEXT.md` initially, including the monorepo's software and research workflows. Split into context-specific records only after a decision establishes distinct meanings or ownership.

Consequential architectural decisions may live under `.pi-flow/docs/adr/` when hard to reverse, surprising without their rationale, and chosen after a real trade-off. Ordinary Wayfinder questions and resolutions stay in GitHub Issues, not ADRs.

## Rules

- Preserve T3's existing meanings of environment, project, thread, provider, and run.
- Use the same terms in issues, specifications, experiments, and tests.
- Surface a terminology or ADR conflict before changing its meaning.
- Keep implementation plans and research findings in the configured tracker.
