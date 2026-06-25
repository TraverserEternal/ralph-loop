import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";

export const RalphLoopPlugin = async ({ directory }) => {
  return {
    tool: {
      "ralph-loop": tool({
        description:
          "Execute a Ralph Loop plan from a JSON file. Supports multiple concurrent sets, each on their own branch in their own worktree. Iterates through each step per set, spawning a fresh opencode session per step. Retries once on failure. Adds git notes to each commit with step context.",
        args: {
          jsonPath: tool.schema
            .string()
            .describe("Path to the Ralph Loop JSON plan file"),
        },
        async execute(args, context) {
          const cwd = context.worktree || context.directory || directory;
          const jsonPath = args.jsonPath;

          let plan;
          try {
            const raw = readFileSync(jsonPath, "utf-8");
            plan = JSON.parse(raw);
          } catch (err) {
            return `Cannot read or parse "${jsonPath}" — ${err.message}`;
          }

          // Backward compat: wrap old { branchName, steps } as a single set
          if (!plan.sets) {
            if (
              !plan.branchName ||
              !Array.isArray(plan.steps) ||
              plan.steps.length === 0
            ) {
              return "Plan must have a sets array, or a branchName and a non-empty steps array.";
            }
            plan.sets = [
              {
                description: plan.description || "",
                branchName: plan.branchName,
                steps: plan.steps,
              },
            ];
            delete plan.branchName;
            delete plan.steps;
          }

          if (!Array.isArray(plan.sets) || plan.sets.length === 0) {
            return "Plan must have a non-empty sets array.";
          }

          // Shared temp dir for per-set JSON files and worktrees
          const tmpDir = mkdtempSync("/tmp/ralph-sets-");

          // Write per-set JSON files
          const setFiles = plan.sets.map((set, i) => {
            const setPlan = { branchName: set.branchName, steps: set.steps };
            const filePath = join(tmpDir, `set-${i}.json`);
            writeFileSync(filePath, JSON.stringify(setPlan, null, 2));
            return filePath;
          });

          // Create a git worktree for each set
          const worktreeDirs = [];
          try {
            for (let i = 0; i < plan.sets.length; i++) {
              const branchName = plan.sets[i].branchName;
              const wtDir = join(tmpDir, `wt-${i}`);
              try {
                execSync(
                  `git worktree add -b "${branchName}" "${wtDir}"`,
                  { cwd, stdio: "pipe" }
                );
              } catch {
                execSync(
                  `git worktree add "${wtDir}" "${branchName}"`,
                  { cwd, stdio: "pipe" }
                );
              }
              worktreeDirs.push(wtDir);
            }

            // Execute all sets concurrently, each in its own worktree
            const setPromises = plan.sets.map((set, i) =>
              executeSet(worktreeDirs[i], setFiles[i], i, plan.sets.length)
            );
            const results = await Promise.allSettled(setPromises);

            // Merge results back into the main plan
            let anyFailed = false;
            for (let i = 0; i < plan.sets.length; i++) {
              try {
                const resultSet = JSON.parse(
                  readFileSync(setFiles[i], "utf-8")
                );
                plan.sets[i].steps = resultSet.steps;
                if (resultSet._aborted) {
                  plan.sets[i]._aborted = true;
                  anyFailed = true;
                }
              } catch {
                anyFailed = true;
              }
            }

            // Write merged plan back to original JSON
            writeFileSync(jsonPath, JSON.stringify(plan, null, 2));

            const report = buildReport(plan);

            if (anyFailed) {
              return `Ralph Loop — one or more sets failed.\n\n${report}`;
            }

            const totalSteps = plan.sets.reduce(
              (acc, s) => acc + (s.steps || []).length,
              0
            );
            return (
              `Ralph Loop — all ${plan.sets.length} set(s), ` +
              `${totalSteps} step(s) completed.\n\n${report}`
            );
          } finally {
            // Clean up worktrees
            for (const wtDir of worktreeDirs) {
              try {
                execSync(`git worktree remove --force "${wtDir}"`, {
                  cwd,
                  stdio: "pipe",
                });
              } catch {}
            }
          }
        },
      }),
    },
  };
};

async function executeSet(cwd, setFilePath, setIndex, totalSets) {
  const plan = JSON.parse(readFileSync(setFilePath, "utf-8"));
  const { steps } = plan;

  let aborted = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.status !== "pending") continue;

    step.status = "in-progress";
    savePlan(setFilePath, steps);

    const ok = await attemptStep(
      cwd, setFilePath, steps, step, i, steps.length, false
    );

    if (ok) {
      await finalizeStep(cwd, setFilePath, steps, step);
      process.stdout.write(
        `  [Set ${setIndex + 1}/${totalSets}] ✓ [${i + 1}/${steps.length}] ${step.gitCommitName}\n`
      );
    } else {
      const headBefore = execSync("git rev-parse HEAD", { cwd })
        .toString()
        .trim();
      execSync(`git reset --hard ${headBefore}`, { cwd, stdio: "pipe" });

      step.status = "retrying";
      savePlan(setFilePath, steps);

      const retryOk = await attemptStep(
        cwd, setFilePath, steps, step, i, steps.length, true
      );

      if (retryOk) {
        await finalizeStep(cwd, setFilePath, steps, step);
        process.stdout.write(
          `  [Set ${setIndex + 1}/${totalSets}] ✓ [${i + 1}/${steps.length}] ${step.gitCommitName} (retried)\n`
        );
      } else {
        step.status = "failed";
        step.gitCommitHash = "";
        savePlan(setFilePath, steps);
        process.stdout.write(
          `  [Set ${setIndex + 1}/${totalSets}] ✗ [${i + 1}/${steps.length}] ${step.gitCommitName}\n`
        );
        aborted = true;
        break;
      }
    }
  }

  if (aborted) {
    const p = JSON.parse(readFileSync(setFilePath, "utf-8"));
    p._aborted = true;
    writeFileSync(setFilePath, JSON.stringify(p, null, 2));
  }
}

async function attemptStep(cwd, setFilePath, steps, step, index, total, isRetry) {
  const prompt = buildPrompt(step, index, total, isRetry);
  const headBefore = execSync("git rev-parse HEAD", { cwd })
    .toString()
    .trim();

  let usage = null;

  try {
    const result = await spawnOpencode(cwd, prompt);
    usage = parseTokenUsageFromOutput(result.stdout);

    const headAfter = execSync("git rev-parse HEAD", { cwd })
      .toString()
      .trim();

    if (!step.tokenUsage) step.tokenUsage = [];
    step.tokenUsage.push(usage);
    savePlan(setFilePath, steps);

    return result.status === 0 && headAfter !== headBefore;
  } catch {
    if (!step.tokenUsage) step.tokenUsage = [];
    step.tokenUsage.push(usage);
    savePlan(setFilePath, steps);
    return false;
  }
}

function spawnOpencode(cwd, prompt) {
  return new Promise((resolve) => {
    const proc = spawn(
      "opencode",
      ["run", "--dir", cwd, "--format", "json", prompt],
      {
        cwd,
        stdio: "pipe",
        timeout: 600_000,
      }
    );
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.on("close", (code) => resolve({ status: code, stdout }));
    proc.on("error", () => resolve({ status: 1, stdout: "" }));
  });
}

async function finalizeStep(cwd, setFilePath, steps, step) {
  const headAfter = execSync("git rev-parse HEAD", { cwd })
    .toString()
    .trim();
  step.gitCommitHash = headAfter;

  const branchName = JSON.parse(readFileSync(setFilePath, "utf-8")).branchName;
  const note = [
    `Ralph Loop Step`,
    `Branch: ${branchName}`,
    `Description: ${step.description}`,
    `Requirements: ${step.requirements}`,
    `Tests: ${step.tests}`,
    `Human Confirmation: ${step.humanConfirmationSteps}`,
  ].join("\n");

  const tmp = mkdtempSync("/tmp/ralph-note-");
  const tmpFile = join(tmp, "note.txt");
  writeFileSync(tmpFile, note, "utf-8");
  try {
    execSync(`git notes add ${headAfter} -F "${tmpFile}"`, {
      cwd,
      stdio: "pipe",
    });
  } catch {
  }
  execSync(`rm -rf "${tmp}"`);

  step.status = "completed";
  savePlan(setFilePath, steps);
}

function buildPrompt(step, index, total, isRetry) {
  const parts = [
    `You are working on step ${index + 1} of ${total} in a Ralph Loop plan. Your job is to implement ONLY this step — do not modify files unrelated to it.`,
    ``,
    `## Step: ${step.description}`,
    ``,
    `### Requirements`,
    step.requirements,
    ``,
    `### Change Analysis`,
    step.changeAnalysis,
    ``,
    `### Tests`,
    step.tests,
    ``,
    `### Human Confirmation`,
    step.humanConfirmationSteps,
    ``,
    `## Instructions`,
    `1. Study the codebase to understand the current state`,
    `2. Implement ALL changes required for this step — nothing more, nothing less`,
    `3. Do NOT touch files unrelated to this step`,
    `4. Run the tests to verify correctness`,
    `5. Stage your changes with \`git add\``,
    `6. Create a commit with EXACTLY this title: ${step.gitCommitName}`,
    `7. The commit body MUST contain detailed notes explaining:`,
    `   - Which files were changed and how`,
    `   - The reasoning behind each change`,
    `   - Any design decisions or trade-offs made`,
    `   - How the changes satisfy the requirements`,
    `8. If tests fail or you cannot complete this step, do NOT create a commit`,
  ];

  if (isRetry) {
    parts.push(
      ``,
      `## Note: This is a RETRY of a step that previously failed.`,
      `The repository has been reset to before the failed attempt.`,
      `Be extra thorough — double-check your implementation and test it carefully before committing.`
    );
  }

  return parts.join("\n");
}

function parseTokenUsageFromOutput(stdout) {
  if (!stdout) return null;

  const lines = stdout.split("\n");
  let total = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "step_finish" && event.part?.tokens) {
        const t = event.part.tokens;
        if (!total) {
          total = {
            input: 0,
            output: 0,
            reasoning: 0,
            cacheWrite: 0,
            cacheRead: 0,
            cost: 0,
          };
        }
        total.input += t.input || 0;
        total.output += t.output || 0;
        total.reasoning += t.reasoning || 0;
        total.cacheWrite += t.cache?.write || 0;
        total.cacheRead += t.cache?.read || 0;
        total.cost += event.part.cost || 0;
      }
    } catch {
    }
  }

  return total;
}

function buildReport(plan) {
  const sets = plan.sets || [];
  const lines = ["## Token Usage"];
  const grandTotal = {
    input: 0, output: 0, reasoning: 0,
    cacheWrite: 0, cacheRead: 0, cost: 0,
  };
  let hasData = false;

  for (let s = 0; s < sets.length; s++) {
    const set = sets[s];
    const steps = set.steps || [];
    const label = set.description || set.branchName || `Set ${s + 1}`;
    lines.push(`\n### Set ${s + 1}: ${label}`);

    const setTotal = {
      input: 0, output: 0, reasoning: 0,
      cacheWrite: 0, cacheRead: 0, cost: 0,
    };

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const usageArr = step.tokenUsage || [];
      const stepTotal = {
        input: 0, output: 0, reasoning: 0,
        cacheWrite: 0, cacheRead: 0, cost: 0,
      };

      for (const u of usageArr) {
        if (u) {
          stepTotal.input += u.input || 0;
          stepTotal.output += u.output || 0;
          stepTotal.reasoning += u.reasoning || 0;
          stepTotal.cacheWrite += u.cacheWrite || 0;
          stepTotal.cacheRead += u.cacheRead || 0;
          stepTotal.cost += u.cost || 0;
        }
      }

      if (usageArr.some((u) => u !== null)) hasData = true;

      const totalTokens =
        stepTotal.input + stepTotal.output + stepTotal.reasoning;
      let stepLine = `  **Step ${i + 1}:** ${totalTokens.toLocaleString()} total`;
      if (
        stepTotal.input > 0 ||
        stepTotal.output > 0 ||
        stepTotal.reasoning > 0
      ) {
        stepLine += ` (${stepTotal.input.toLocaleString()} in + ${stepTotal.output.toLocaleString()} out + ${stepTotal.reasoning.toLocaleString()} reasoning)`;
      }
      if (stepTotal.cost > 0) {
        stepLine += ` — cost: $${stepTotal.cost.toFixed(6)}`;
      }
      const stepLabel = step.description || step.gitCommitName;
      lines.push(stepLine + `  — ${stepLabel}`);

      setTotal.input += stepTotal.input;
      setTotal.output += stepTotal.output;
      setTotal.reasoning += stepTotal.reasoning;
      setTotal.cacheWrite += stepTotal.cacheWrite;
      setTotal.cacheRead += stepTotal.cacheRead;
      setTotal.cost += stepTotal.cost;
    }

    const setTotalTokens =
      setTotal.input + setTotal.output + setTotal.reasoning;
    let setLine = `  **Set ${s + 1} total:** ${setTotalTokens.toLocaleString()} total`;
    if (
      setTotal.input > 0 ||
      setTotal.output > 0 ||
      setTotal.reasoning > 0
    ) {
      setLine += ` (${setTotal.input.toLocaleString()} in + ${setTotal.output.toLocaleString()} out + ${setTotal.reasoning.toLocaleString()} reasoning)`;
    }
    if (setTotal.cost > 0) {
      setLine += ` — cost: $${setTotal.cost.toFixed(6)}`;
    }
    lines.push(setLine);

    grandTotal.input += setTotal.input;
    grandTotal.output += setTotal.output;
    grandTotal.reasoning += setTotal.reasoning;
    grandTotal.cacheWrite += setTotal.cacheWrite;
    grandTotal.cacheRead += setTotal.cacheRead;
    grandTotal.cost += setTotal.cost;
  }

  lines.push(`\n### Grand Total`);
  if (hasData) {
    const grandTotalTokens =
      grandTotal.input + grandTotal.output + grandTotal.reasoning;
    let totalLine = `  **Total:** ${grandTotalTokens.toLocaleString()} total`;
    if (
      grandTotal.input > 0 ||
      grandTotal.output > 0 ||
      grandTotal.reasoning > 0
    ) {
      totalLine += ` (${grandTotal.input.toLocaleString()} in + ${grandTotal.output.toLocaleString()} out + ${grandTotal.reasoning.toLocaleString()} reasoning)`;
    }
    if (grandTotal.cost > 0) {
      totalLine += ` — cost: $${grandTotal.cost.toFixed(6)}`;
    }
    lines.push(totalLine);
  } else {
    lines.push(
      "  _(No token usage data collected — session produced no JSON output)_"
    );
  }

  if (grandTotal.cacheWrite > 0 || grandTotal.cacheRead > 0) {
    lines.push(
      `  **Cache:** ${grandTotal.cacheWrite.toLocaleString()} written, ${grandTotal.cacheRead.toLocaleString()} read`
    );
  }

  return lines.join("\n");
}

function savePlan(setFilePath, steps) {
  const current = JSON.parse(readFileSync(setFilePath, "utf-8"));
  current.steps = steps;
  writeFileSync(setFilePath, JSON.stringify(current, null, 2));
}
