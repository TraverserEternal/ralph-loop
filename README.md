# Ralph Loop

A [opencode](https://opencode.ai) plugin + skill that breaks large coding tasks into **sets** of small sequential steps. Each set runs on its own branch. Sets execute **concurrently**; steps within a set run **sequentially** in separate opencode sessions (fresh context every time). Retries once on failure. Tracks token usage per step.

## What problem does it solve?

Large coding tasks hit two problems in agentic coding tools:

1. **Context bleed** — the agent's context window fills up and it starts losing track of earlier decisions
2. **No parallelism** — independent changes have to wait for each other

Ralph Loop solves both: each step starts with a clean context, and independent groups of work run on parallel branches.

## Installation

```bash
# 1. Install the plugin
mkdir -p ~/.config/opencode/plugins
cp plugin/ralph-loop.js ~/.config/opencode/plugins/

# 2. Install the skill
mkdir -p ~/.config/opencode/skills/ralph-loop
cp skill/SKILL.md ~/.config/opencode/skills/ralph-loop/

# 3. Reference both in ~/.config/opencode/opencode.json:
```

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "skills": {
    "paths": ["~/.config/opencode/skills"]
  }
  // plugin is auto-discovered from ~/.config/opencode/plugins/
}
```

That's it. Restart opencode. On next startup the `ralph-loop` tool and skill are active.

## Usage

### 1. Ask the agent to create a plan

Describe the task to an opencode agent. It will analyze the codebase and produce a JSON plan file. The plan defines sets (parallel branches), each with sequential steps.

### 2. Execute the plan

In opencode, invoke the `ralph-loop` tool with the path to your plan file.

### 3. Review the results

Each set produces a branch (`ralph/phase-1`, etc.) with sequential commits. The tool reports token usage per step, per set, and a grand total.

## Requirements

- [opencode](https://opencode.ai) v1.15+
- `git` on `PATH`
- `opencode` on `PATH`

## Plan file format

```json
{
  "sets": [
    {
      "description": "Backend API",
      "branchName": "ralph/backend",
      "steps": [
        {
          "description": "Add user auth middleware",
          "gitCommitName": "feat: add user auth middleware",
          "gitCommitHash": "",
          "requirements": "Implement JWT-based auth middleware...",
          "changeAnalysis": "src/middleware/auth.ts: new file...",
          "tests": "Run `npm test auth`",
          "humanConfirmationSteps": "Verify token validation works",
          "status": "pending"
        }
      ]
    }
  ]
}
```

## How it works

1. Agent writes the plan JSON file
2. User invokes the `ralph-loop` tool
3. Plugin creates a **git worktree** per set in `/tmp/`
4. All sets execute concurrently; steps within a set run sequentially
5. Each step spawns `opencode run --dir <worktree> --format json <step prompt>`
6. After each successful step, the tool creates a git commit and adds a git note
7. Failed steps retry once; if still failing the set is aborted
8. Worktrees are cleaned up automatically
9. A token usage report is returned

## License

MIT
