---
name: analyse-changes
description: Walk through commits from one or more Ralph Loop branches and collect human review notes per commit. Use when the user wants to review or annotate commits from a Ralph Loop plan.
---

# Skill: analyse-changes

Analyse commits in a Ralph Loop plan with multiple sets/branches, collecting human review notes per commit.

## Workflow

1. **Determine scope** — Ask the user for the path to a Ralph Loop plan JSON file. If they don't have one, fall back to the current branch (single-branch mode).

2. **Parse plan (multi-branch mode)** — Read the plan JSON. If it has a `sets` array, extract each set's `branchName`. If it's the old format (single `branchName` + `steps`), wrap it as one set. For each set:
   - Record the branch name and set description
   - Checkout that branch: `git checkout <branchName> --quiet`
   - Get its commits: `git log main..HEAD --reverse --format="%H|||%s|||%an|||%ai"`
   - Build an array of commit objects per set

3. **Initialize state** — Create an empty map `notesBySet: { [setLabel]: [{ hash, subject, author, date, note }] }` and a counter `commitIndex = 0` for the current set.

4. **Main loop** — Iterate over each set's commits one by one:
   a. **Checkout** the commit: `git checkout <hash> --quiet`
   b. **Display** the commit info:
      ```
      Set 1/3 — Commit 3/5 — abc1234
      Author: Jane Doe
      Date:   2026-05-20
      Title:  feat: add login form

      ---
      ```
   c. **Wait for user input**. The user may:
      - Give **notes** — capture whatever they say and store it as the note for this commit.
      - Say **"go next"**, **"next"**, **"continue"**, or **"n"** — store an empty note (no review) and advance.
      - Say **"skip"** — store `"skipped"` as the note and advance.
      - Say **"done"** or **"finish"** — store any note given so far and exit the loop early.
   d. Increment `commitIndex`; when all commits in a set are done, move to the next set's first commit.

5. **Write notes** — Write `notes-on-changes.md` with this format:

   ```markdown
   # Changes Review

   Date:   <date>

   ## Set 1: Phase 1 — Scaffold portfolio (ralph/portfolio-scaffold)

   1. **abc1234** — feat: add login form
      Author: Jane Doe | 2026-05-20
      > User's note about this commit or "*(no notes)*"

   2. **def5678** — fix: validate email
      Author: John Doe | 2026-05-21
      > User's note about this commit

   ## Set 2: Phase 2 — Content and styling (ralph/portfolio-content)

   1. **789abcd** — feat: add portfolio pages
      Author: Jane Doe | 2026-05-22
      > User's note about this commit
   ```

6. **Cleanup** — Checkout back to the original branch tip: `git checkout <original-branch> --quiet`

## Single-branch fallback

If no plan file is provided, use the original workflow:
- Run `git log main..HEAD --reverse --format="%H|||%s|||%an|||%ai"` and parse the output.
- Walk through commits with the same review loop (omit the set prefix from display).
- Write a flat `notes-on-changes.md` without per-set sections.
- If `main` branch doesn't exist, fall back to `master`. If neither exists, ask the user which branch is the base.

## Notes

- **Crucial: checkout the commit BEFORE displaying its info** — the user needs to see the code in that state, not the branch tip.
- Accept any casing and extra words (e.g. "go next", "Go Next", "ok next", "next please"). Match on the word "next", "continue", "skip", "done", or "finish".
- If the user gives notes but also says "next" in the same message, store the notes and advance.
- In single-branch mode, the commit counter shows as `Commit 3/5`; in multi-branch mode it's `Set 1/3 — Commit 3/5`.
