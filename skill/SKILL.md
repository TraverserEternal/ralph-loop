---
name: ralph-loop
description: Use when the user asks to break a large task into parallel sets of sequential steps using the ralph-loop tool/plugin. Plan and write the JSON plan file, then they invoke the tool. Use ONLY when creating or executing Ralph Loop plans.
---

# Skill: ralph-loop

## What is a Ralph Loop?

A Ralph Loop takes a large coding task and breaks it into **sets** of small, sequential steps, where each set runs on its own branch. Sets execute **concurrently** (independent branches), while steps within a set run **sequentially**.

Each step:

- Is implemented in a **separate opencode session** (fresh context, no context bleed)
- Gets its own **git commit** on its set's feature branch
- Has clear requirements, change analysis, tests, and human review notes
- Retries once on failure
- **Token usage is tracked per step** — a report with per-set and grand total token counts (input, output, reasoning) and cost is appended to the final result

## JSON Schema

The plan file follows this structure:

```json
{
  "sets": [
    {
      "description": "Optional label for this set (appears in reports)",
      "branchName": "ralph/phase-1",
      "steps": [
        {
          "description": "Brief summary of what this step accomplishes",
          "gitCommitName": "conventional commit message for this step",
          "gitCommitHash": "",
          "requirements": "What must be implemented — functional and non-functional requirements",
          "changeAnalysis": "Which files need to change and how — be specific",
          "tests": "How to verify correctness — unit tests, integration tests, manual checks",
          "humanConfirmationSteps": "What a reviewer should manually verify before considering this done",
          "status": "pending"
        }
      ]
    }
  ]
}
```

### Backward compatibility

Old-format plans (single `branchName` + `steps` at top level, no `sets` key) are **auto-wrapped** as a single set and continue to work.

### Field Guidelines

| Field | Description |
|-------|-------------|
| `sets[].description` | Optional human-readable label for reports |
| `sets[].branchName` | Feature branch name, prefixed with `ralph/` |
| `sets[].steps[].description` | 1–2 sentence summary of the step |
| `sets[].steps[].gitCommitName` | Conventional commit message title (e.g., `feat: add user auth middleware`) |
| `sets[].steps[].gitCommitHash` | Leave empty — filled automatically during execution |
| `sets[].steps[].requirements` | What the implementation must achieve |
| `sets[].steps[].changeAnalysis` | Specific files, modules, or patterns that need changing |
| `sets[].steps[].tests` | How to verify the step is correct |
| `sets[].steps[].humanConfirmationSteps` | What a reviewer must check |
| `sets[].steps[].status` | Always `"pending"` — updated by the executor |
| `sets[].steps[].tokenUsage` | (Auto-populated) Array of per-attempt token usage objects — each contains `input`, `output`, `reasoning`, `cacheWrite`, `cacheRead`, `cost`. Initially absent; filled by the executor. |

## Workflow

1. The agent analyzes the codebase and breaks the task into logical sets and steps
2. The agent writes the JSON plan file to a path the user specifies
3. The user invokes the `ralph-loop` tool (via the plugin) to execute the plan
4. The plugin creates a **git worktree** for each set (one worktree per branch in `/tmp/`)
5. All sets execute **concurrently** in their own worktrees; within a set, each step runs in its own opencode session, creating separate commits on that branch
6. If a step fails, the tool retries once before marking it failed and setting the set as aborted
7. On completion (success or failure), all worktrees are cleaned up automatically
8. A token usage report (per-set + grand total) is always shown at the end, even if some sets abort

## How to Plan

- Study the codebase structure first — understand existing patterns before planning
- Group related work into **sets** that can run on independent branches concurrently
- Each step should produce a **working, testable, commit-able** increment
- Steps should be ordered so each builds on the previous one (within a set)
- If a step depends on another not yet listed, reorder — no circular dependencies
- Keep steps focused: one concern per step
- Sets are **independent** — they should not have file conflicts (different branches)
- Write clear `requirements` and `changeAnalysis` so the executor can work independently
