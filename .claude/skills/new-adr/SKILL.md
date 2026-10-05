---
name: new-adr
description: Create the next numbered architecture decision record in docs/adr/ from the 0000 template. Use when the user wants to record, propose or write up an architecture decision.
argument-hint: <decision title>
---

# New ADR

Title: $ARGUMENTS

1. If the title is empty, ask for a short decision title and stop.
2. List `docs/adr/` and take the highest `NNNN-*.md` number, plus one, zero-padded to four digits.
   M3 (`docs/plan/04_M3_design.md`) already names three: `0005-risk-model-v0`,
   `0006-station-segment-mapping` and `0007-streaming-semantics`. If the decision is one of those, use that
   number and file name; otherwise skip past them.
3. Build the file name `docs/adr/<NNNN>-<kebab-case-title>.md`, at most six words in the slug.
4. Copy `docs/adr/0000-template.md` and fill it in:
   - Heading `# ADR-<NNNN>: <title>`
   - `Status: Proposed`, `Date:` today (YYYY-MM-DD), `Owner:` from `git config user.name`
   - Context, Options considered, Decision and Consequences from the conversation. Where something is not
     known yet, write `TBD` rather than inventing it.
5. Match the style of the existing ADRs (`docs/adr/0001-*.md` to `0004-*.md`): short paragraphs, options
   as a list with one line on why each was or was not chosen.
6. If the decision supersedes an earlier ADR, set that ADR's status to `Superseded by ADR-<NNNN>`.
7. Report the new path. Do not commit.
