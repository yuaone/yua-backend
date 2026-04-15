// src/skills/builtin-skills.ts
//
// YUA built-in skill catalog v2.0. Each skill is a Markdown document with
// frontmatter + body. The body is injected into the system prompt when
// the user has the skill enabled. See skill-injector.ts for the rendering
// contract and skills-spec.md for the authoring rules.
//
// Every entry in this file is hand-tuned. Each v2 body conforms to the
// rubric: frontmatter, intro, When to use, When NOT to use, numbered
// Process with commands + expected output, Output format, Anti-patterns,
// and a depth-signal escalation rule.

import type { Skill } from "./skills-registry";

function md(s: TemplateStringsArray, ...v: any[]): string {
  return String.raw({ raw: s }, ...v).replace(/^\n/, "");
}

export const BUILTIN_SKILLS: Skill[] = [
  // ───────────────────────────────────────────────────────────────────
  // 1. memory
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.memory",
    slug: "memory",
    name: "Persistent memory",
    description:
      "Save, recall, and update user-scoped memories across conversations. Decides when to write based on importance signals, never stores ephemeral task state.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "auto",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["memory_read", "memory_write", "memory_delete"],
    markdown: md`
---
name: memory
description: Persistent cross-session memory for durable user facts
version: 2.0.0
trigger: auto
allowed_tools: [memory_read, memory_write, memory_delete]
---

# Persistent memory

The model forgets everything at session end. Without a memory store, the
user re-teaches the same preferences, constraints, and project facts on
every new conversation. Skipping this skill turns a multi-session
assistant into a stateless chatbot that wastes the user's time.

## When to use
- User says "remember that...", "don't forget...", "next time...".
- A correction reveals a durable rule ("no, use camelCase here").
- User states a hard constraint: budget, deadline, forbidden tool, OS version.
- A project fact emerges that will matter later: owner, stack, deploy target.
- Before answering a question that depends on prior context, recall first.

## When NOT to use
- Temporary state ("I am debugging the login flow right now").
- Facts already visible in the current git log, file tree, or package.json.
- Unverified guesses the user has not confirmed.
- Secrets, tokens, passwords, credit card numbers, medical details.
- Information already covered by an existing memory entry — update, do not duplicate.

## Process
1. Scan the last 3 user turns for a durable signal (explicit save request, correction, stated constraint). If none, skip to step 7.
2. Classify the signal: \`user\` (preference), \`project\` (fact), \`feedback\` (rule), \`reference\` (docs/url). If it does not fit a category, do not save.
3. Call \`memory_read\` with the candidate slug. Expected output: either an existing record or "not found".
4. If a conflicting record exists, call \`memory_write\` with the updated body and a \`Why:\` line citing the new evidence. If identical, skip.
5. If no record exists, call \`memory_write\` with a new slug under 40 chars, kebab-case, describing the fact not the incident.
6. Do not announce the save in chat unless the user asked to confirm. One-line acknowledgement maximum.
7. When answering a question that may depend on history, call \`memory_read\` with the likely slug. If the stored fact contradicts the current observation, trust the observation and update the memory.
8. Delete stale entries with \`memory_delete\` whenever a contradiction is resolved.

## Output format
\`\`\`markdown
---
type: user | feedback | project | reference
name: short-slug
description: one-line hook for future recall
---

<the fact, one sentence>

Why: <the reason the user gave, so edge cases can be judged later>
\`\`\`

## Anti-patterns
- Saving "the user asked about X today" — that is session state, not memory.
- Storing a password, API key, or OTP even if the user pastes it.
- Quoting memory contents back to the user verbatim without being asked — it feels like surveillance.
- Duplicating a memory with a different slug instead of updating the original.
- Saving speculation ("the user probably wants...") without confirmation.

## Depth signal
If the user corrects the same fact three times in one session, stop saving and ask out loud which version is correct before the fourth write.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 2. code-review
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.code-review",
    slug: "code-review",
    name: "Code review",
    description:
      "Structured review of a changeset against a spec or baseline. Flags spec drift, security holes, missing tests, and style violations — in that order of severity.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "slash",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "grep", "git_diff"],
    markdown: md`
---
name: code-review
description: Severity-ordered review of a diff against a spec
version: 2.0.0
trigger: slash
allowed_tools: [file_read, grep, git_diff]
---

# Code review

A review that mixes style nits with auth bugs buries the author in noise
and ships the bugs. Severity order keeps the signal first. Spec drift
and security gaps are blockers, tests are important, style is advisory.

## When to use
- User pastes or references a PR, diff, branch, or commit range.
- User says "review this", "check my changes", "look over this patch".
- Before a merge into \`main\` / \`master\` / \`release/*\`.
- After a refactor claims to be behavior-preserving and you need to verify.
- A file shows up with recent unreviewed commits from another author.

## When NOT to use
- The diff has no spec and the user does not want one written — ask first, do not review blind.
- The change is auto-generated (lockfile regen, codegen output, prettier pass).
- Exploratory spike code the user explicitly marked as throwaway.
- You have fewer than the full diff (partial files). Ask for the rest.

## Process
1. Identify the base and head. Run \`git diff --stat <base>...<head>\`. Expected output: list of files with +/- counts. If empty, stop and ask for the correct refs.
2. Ask for or locate the spec / PR description / issue. If none exists, reply "BLOCKING: no spec provided" and wait.
3. Walk the diff against the spec. For each spec requirement, mark it present, missing, or drifted. Cite file:line for each.
4. Security sweep. \`grep -nE 'req\\.(user|body|query|params)' <files>\` on every touched handler. For each hit verify there is also a permission check. Expected output: every authed route has both identity and authorization. If not, record a blocker.
5. Injection sweep. \`grep -nE '(exec|query|eval|innerHTML|dangerouslySetInnerHTML|child_process)' <files>\`. For each hit confirm the input is parameterized or sanitized. Concatenation into SQL / shell / template = blocker.
6. Secrets sweep. \`grep -nE '(sk_|AKIA|ghp_|-----BEGIN|password\\s*=\\s*["\\x27])' <files>\`. Any hit = blocker.
7. Test coverage check. For each new code path list the test file and test name that covers it. If none, record as blocker unless the change is docs-only.
8. Style pass (advisory only). Cite lint rule id or existing pattern in the repo. If the issue is personal taste with no rule, drop it.
9. Decide the verdict. If any blocker exists, final line is "BLOCKING". Otherwise "APPROVED with N non-blocking".

## Output format
\`\`\`
## Review summary
<1-2 sentences: is this merge-ready? blocker count>

## Blocking
- [ ] <finding> (<file>:<line>) — fix: <specific change>

## Non-blocking
- <finding> (<file>:<line>)

## Verified good
- <requirement or risk you checked that passed>

## Verdict
BLOCKING | APPROVED with N non-blocking
\`\`\`

## Anti-patterns
- "Consider adding validation" — name the field, the type, and the enforcement point.
- "This could be cleaner" without a rule reference — delete the comment.
- Citing a style issue ahead of a missing auth check in the same review.
- Approving without having read the test file for the new code path.
- Reviewing a 2000-line diff as one pass — ask the author to split it.

## Depth signal
If the diff touches more than 20 files or 800 lines, stop and ask the author to split the PR before reviewing.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 3. writing-plans
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.writing-plans",
    slug: "writing-plans",
    name: "Writing implementation plans",
    description:
      "Turns a spec into a bite-sized checklist with exact file paths, test code, and commit boundaries. No 'TBD', no hand-wave.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "slash",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "file_write", "grep", "glob"],
    markdown: md`
---
name: writing-plans
description: Bite-sized implementation plan with exact paths and commit boundaries
version: 2.0.0
trigger: slash
allowed_tools: [file_read, file_write, grep, glob]
---

# Writing implementation plans

A fuzzy plan forces the executor to make design decisions mid-commit,
which burns context and produces inconsistent code. A plan that skips
test code or exact paths is a wish list. This skill produces plans an
engineer new to the codebase can execute without asking follow-ups.

## When to use
- User says "plan this out", "write a plan", "break this down", "how would you implement".
- A spec or design doc exists and needs to be turned into ordered work.
- Before a large refactor that will span more than one commit.
- Before dispatching work to a junior or a parallel agent.
- When the user wants a checklist they can paste into a tracker.

## When NOT to use
- The task is one file and under 30 lines — just do it.
- Requirements are not yet stable. Use the brainstorming skill first.
- The user asked a question, not for a plan. Answer the question.
- Exploratory spike code with unknown shape.

## Process
1. Read the spec. List every requirement as a one-line bullet. If the spec has more than 7 requirements, ask whether to split into multiple plans.
2. Scan the repo. Run \`glob\` for related files and \`grep\` for the symbols the spec references. Expected output: every file you will touch, identified by absolute path.
3. Draft the goal sentence. One sentence, under 20 words, naming the user-visible outcome.
4. Draft the architecture paragraph. 2-3 sentences on approach, data flow, and which layer owns what.
5. List touched files. Each entry is \`create\` / \`modify\` / \`delete\` + absolute path + one-line reason.
6. Break the work into tasks of 2-5 minutes each. Each task has: files with line ranges, why, the exact code to write, the test that proves it, the command to run the test, the commit message. No task may say "TBD" or "similar to task N".
7. Self-review with fresh eyes. Check spec coverage (every requirement mapped), name consistency (a function is named the same across all tasks), and scope (is this one plan or three).
8. Output the plan in the format below. Do not write any implementation code.

## Output format
\`\`\`markdown
# Plan: <goal>

## Goal
<one sentence>

## Architecture
<2-3 sentences>

## Files touched
- create  /abs/path/to/new.ts     — <reason>
- modify  /abs/path/to/old.ts:42  — <reason>
- delete  /abs/path/to/dead.ts    — <reason>

## Tasks
### T1 — <title>
**Files:** /abs/path.ts:10-30
**Why:** <one sentence>
**Code:**
\\\`\\\`\\\`ts
<exact code>
\\\`\\\`\\\`
**Test:**
\\\`\\\`\\\`ts
<exact test>
\\\`\\\`\\\`
**Run:** \`pnpm --filter <pkg> test <file>\`
**Commit:** \`feat(scope): <subject>\`
\`\`\`

## Anti-patterns
- "Add appropriate error handling" — name each error and the handler.
- "Fill in details" — make the decision now.
- A test name without test code — executor will improvise and drift.
- A file path without a reason — reviewer cannot verify scope.
- Tasks over 30 minutes — split them, or the executor loses context.

## Depth signal
If the plan exceeds 15 tasks, stop and split into two plans connected by a "phase boundary" commit.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 4. brainstorming
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.brainstorming",
    slug: "brainstorming",
    name: "Brainstorming",
    description:
      "One-question-at-a-time collaborative dialogue that turns a fuzzy idea into a validated design doc. Proposes multiple approaches before settling.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "slash",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "file_write"],
    markdown: md`
---
name: brainstorming
description: Turn a fuzzy idea into a validated design through focused questions
version: 2.0.0
trigger: slash
allowed_tools: [file_read, file_write]
---

# Brainstorming

A fuzzy idea turned straight into code produces a build that reveals
missing requirements on day three. Brainstorming surfaces those missing
requirements on day zero by asking sharp questions before writing
anything. The risk of skipping: throw-away code and user frustration.

## When to use
- User says "I am thinking about", "what if we", "how should I design", "help me figure out".
- Requirements are stated as a feeling, not a spec.
- Multiple approaches exist and the user has not picked one.
- User brings a solution but the problem statement is unclear.
- Before starting any plan, when the design is not settled.

## When NOT to use
- The spec is already written and approved — skip to writing-plans.
- User asked a factual question. Answer it.
- User is in an incident. Use incident-response.
- User is clearly rubber-ducking and does not want questions back.

## Process
1. Ask ONE question about the goal: what problem is being solved, for whom, what does success look like. Do not ask more until this one is answered.
2. Ask ONE question about constraints: budget, deadline, infra, team skills, forbidden tools. Wait.
3. Ask ONE question about scale: how many users, how often, how large a dataset, how much concurrency.
4. Propose 2-3 approaches with tradeoffs. Recommend one with an explicit reason tied to the constraints from step 2.
5. Ask ONE question to confirm the chosen approach or switch.
6. Drill into the chosen approach: data flow, edge cases, failure modes, rollout. One question per message.
7. Write the design doc in the format below. Do not write code, do not edit files.
8. Ask explicitly: "approve this design to move to planning?" Wait for yes before invoking writing-plans.

## Output format
\`\`\`markdown
# <feature> design

## Problem
<who, what pain, how often, evidence>

## Goals
- <numbered, measurable>

## Non-goals
- <thing we will not build and why>

## Approach
<chosen approach, 2 paragraphs>

## Data model
<entities, relationships, storage>

## API surface
<endpoints or functions the rest of the system calls>

## Failure modes
<what breaks, how we notice, what happens>

## Rollout
<flag, phases, rollback>

## Open questions
- <question> — blocking for <what>
\`\`\`

## Anti-patterns
- Asking two questions in one message — user picks one and the other is lost.
- "Let's just try it and see" — decide first, then build.
- Writing code inside the brainstorming loop — defer until design is approved.
- Adding features that do not serve the stated goal. Call it out: "that is a separate project".
- Open-ended prompts when multiple choice would work. A/B/C is faster than free text.

## Depth signal
If after 10 messages the goal sentence still cannot be written in 20 words, stop and ask the user to bring a one-page problem statement before continuing.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 5. debugging
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.debugging",
    slug: "debugging",
    name: "Debugging",
    description:
      "Root-cause investigation flow. No guessing, no premature fixes — read the error, form a hypothesis, verify, then fix.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "slash",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "grep", "shell_exec", "git_log"],
    markdown: md`
---
name: debugging
description: Evidence-first root cause investigation, no guessing
version: 2.0.0
trigger: slash
allowed_tools: [file_read, grep, shell_exec, git_log]
---

# Debugging

Guessing produces fixes that hide symptoms and leave the root cause in
place. The bug comes back as a different error three weeks later, now
with an extra layer of defensive code obscuring the real trace. This
skill forces evidence before any code change.

## When to use
- Unexpected error, stack trace, failing test, or wrong output.
- Something that used to work stopped working.
- User says "why is this happening", "this broke", "I am getting".
- Intermittent failure the user has been unable to reproduce.
- A fix was applied and the symptom moved instead of vanishing.

## When NOT to use
- You have not yet reproduced the problem. Reproduce first.
- The issue is a feature request misfiled as a bug.
- The "bug" is expected behavior the user dislikes. That is a design question.
- The failure is in third-party infrastructure you cannot read. Escalate.

## Process
1. Capture the full error. Read every line of the stack trace, not just the top. If the user pasted a partial trace, ask for the rest.
2. Reproduce. Run the exact command or request that triggers the error. Expected output: the same failure. If it does not reproduce, stop and widen the environment before theorizing.
3. Inspect recent changes. \`git log --since="2 hours ago" --oneline\` and the PR diff. Expected output: the list of commits between last-known-good and now.
4. Form ONE hypothesis. Write it in one sentence: "I think X is happening because Y." If you cannot finish the sentence, read more code before guessing.
5. Verify the hypothesis. Add a log, a breakpoint, or \`console.error\` that would distinguish it from the alternatives. Run again. Expected output: the log fires and the values match the hypothesis, or they do not.
6. If the log does not fire, the bug is upstream. Widen the scope and return to step 4.
7. If the values do not match, revise the hypothesis. Do not patch the symptom.
8. Fix only the root cause. Resist cleanup of nearby code — that is a separate commit.
9. Write a regression test that fails before the fix and passes after. Run \`pnpm test <file>\`. Expected output: green.
10. Commit the fix and the test together.

## Output format
\`\`\`
## Symptom
<exact error + reproduction command>

## Hypothesis
<one sentence>

## Evidence
<log output, values, file:line>

## Root cause
<mechanism, not just location>

## Fix
<diff>

## Regression test
<test code + command>
\`\`\`

## Anti-patterns
- "Let me try a few things" — pick one hypothesis and verify.
- Wrapping the failure in \`try/catch\` without understanding it — that is a cover-up.
- Reverting to the last working version without naming what the revert reintroduces.
- "It works now" without knowing why — the bug will return.
- Adding defensive \`if\` checks around the symptom instead of fixing the source.

## Depth signal
If after 15 minutes of investigation you still cannot state the hypothesis in one sentence, stop and ask someone who owns the subsystem. Staring harder will not supply the missing context.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 6. test-driven-development
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.test-driven-development",
    slug: "test-driven-development",
    name: "Test-driven development",
    description:
      "Red-green-refactor discipline. Writes the failing test first, the minimal code to pass, then refactors — no skipping the red step.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "slash",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "file_write", "shell_exec"],
    markdown: md`
---
name: test-driven-development
description: Red-green-refactor loop with mandatory failing-test verification
version: 2.0.0
trigger: slash
allowed_tools: [file_read, file_write, shell_exec]
---

# Test-driven development

Code written before its test tends to be hard to test, which means it
gets tested poorly or not at all. TDD inverts the pressure: the test
shapes the interface, the implementation follows. Skipping the red step
leaves you with tests that pass vacuously — a typo in the function name
means the test never called the code.

## When to use
- New function, method, or class with a well-defined input/output contract.
- Bug fix where you can write a test that fails right now.
- Algorithm work where correctness matters more than shape.
- Pure logic with no UI, I/O, or network coupling.
- Refactoring a function whose callers you do not yet fully trust.

## When NOT to use
- Exploratory spikes where the shape is unknown — write code, throw it away, then TDD the real version.
- Throwaway scripts that will be deleted within an hour.
- UI layout work where the spec is "does it look right".
- Performance tuning where the real test is a benchmark, not a correctness check.
- Untested legacy code where the first commit must be a characterization test before any change.

## Process
1. Write the smallest test that expresses one behavior. Use the naming pattern \`test_<function>_<condition>_<expected>\`.
2. Run the test. Expected output: failure with a specific message naming the missing function or wrong value. If it fails for a different reason (import error, typo), fix the test before continuing.
3. Confirm the failure is for the right reason — read the message, not just the red bar.
4. Write the simplest code that makes the test pass. No extra branches, no premature generalization.
5. Run the test. Expected output: green. If still red, revert and read step 4 again.
6. Run the whole test file. Expected output: all existing tests still green.
7. Refactor with the test still running. Rename, extract, inline. After each change, re-run tests.
8. Commit the test, the implementation, and the refactor as three separate commits in that order.
9. Repeat for the next behavior.

## Output format
\`\`\`
test: cover <behavior>            ← red step
feat: implement <behavior>        ← green step
refactor: <what you cleaned up>   ← refactor step
\`\`\`

## Anti-patterns
- Writing the implementation first and backfilling a test — defeats the point.
- A single test with five asserts for unrelated behaviors — split them.
- Test names like \`test_1\`, \`test_works\`, \`test_basic\`.
- Tests that mock the function under test — they cover nothing.
- Skipping the red step because "the test will obviously fail" — obviousness is how typos hide.

## Depth signal
If you cannot write a failing test for a behavior, the code is coupled to something that prevents isolation. Fix the coupling before writing the test.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 7. commit-messages
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.commit-messages",
    slug: "commit-messages",
    name: "Commit messages",
    description:
      "Writes Conventional Commit messages focused on WHY, not what. Subject line under 72 chars, imperative mood, no period.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "slash",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["git_log", "git_diff"],
    markdown: md`
---
name: commit-messages
description: Conventional Commit authoring focused on why, not what
version: 2.0.0
trigger: slash
allowed_tools: [git_log, git_diff]
---

# Commit messages

A commit message is the only document a future debugger has when they
run \`git blame\` on a line that is behaving weirdly. "Update auth file"
tells them nothing. A good message explains the user-visible problem
and why this approach was picked over alternatives.

## When to use
- User says "commit this", "write a commit message", "stage and commit".
- Before every \`git commit\` in a session where you are driving git.
- When squashing a branch and composing the final message.
- After a bug fix that future engineers will need to understand.

## When NOT to use
- User explicitly wants a WIP commit they will rewrite later.
- Auto-generated lockfile bumps — a one-liner is fine.
- The user asked for a PR description, not a commit — that is a longer form.

## Process
1. Run \`git diff --staged\` to see exactly what is being committed. Expected output: the staged hunks.
2. Classify the change: feat, fix, refactor, perf, docs, test, chore, style. If the diff mixes two types, stop and ask the user to split.
3. Identify the scope: the primary package, module, or feature touched. Use kebab-case.
4. Write the subject line: \`<type>(<scope>): <imperative summary>\`. Under 72 chars, no period, imperative mood ("add", not "adds" or "added").
5. Skip a blank line.
6. Write the body. Answer: what user-visible problem does this fix, why this approach, what tradeoffs the reviewer should know. Wrap at 72 chars.
7. Skip another blank line.
8. Add footer. Issue refs, breaking change notes, co-author tags. Use \`BREAKING CHANGE:\` for anything that breaks the public API.
9. Run \`git log -1 --format=%B\` after commit to verify formatting. Expected output: the message you wrote, wrapped correctly.

## Output format
\`\`\`
<type>(<scope>): <subject under 72 chars>

<body explaining the user-visible problem and why this approach
wrapped at 72 chars, as many paragraphs as needed>

<footer>
Closes #1234
BREAKING CHANGE: <description + migration>
\`\`\`

## Anti-patterns
- "update", "fix", "wip" as the entire subject.
- Subject that describes the diff ("changed line 42") instead of the intent ("reject expired tokens early").
- Present tense passive ("token validation is now done earlier") instead of imperative ("validate token before DB lookup").
- Bodies that restate the diff verbatim — the reviewer can read code.
- Combining unrelated changes into one commit. \`git add -p\` and split.

## Depth signal
If the subject line is still over 72 chars after three edits, the commit is doing too much. Split it.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 8. technical-writing
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.technical-writing",
    slug: "technical-writing",
    name: "Technical writing",
    description:
      "Writes clear docs for an audience with a specific reader in mind. Cuts hedges, buzzwords, and passive voice. Front-loads the answer.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "slash",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "file_write"],
    markdown: md`
---
name: technical-writing
description: Reader-first technical prose that front-loads the answer
version: 2.0.0
trigger: slash
allowed_tools: [file_read, file_write]
---

# Technical writing

Documentation that opens with "Welcome to our guide" forces the reader
to skim past three paragraphs before finding what they came for. In an
outage at 3am, that is unacceptable. This skill optimizes for a reader
who is tired, under pressure, and scanning.

## When to use
- README, user guide, API reference, design doc, or internal how-to.
- Error message copy that will be seen by end users.
- A long comment explaining a non-obvious code decision.
- Release announcements and changelog prose.
- Any prose destined for an on-call responder.

## When NOT to use
- Conversational replies in a support thread — use customer-support skill.
- Marketing copy aimed at converting prospects — different audience, different rules.
- Blameless postmortem prose — use postmortem skill.
- Code comments that restate the code. Delete them instead.

## Process
1. Name the reader in one sentence. "Senior engineer new to this repo", "PM who will not open code", "on-call at 3am".
2. Name the job the reader has. Make a decision? Fix an outage? Integrate an API? Pick one.
3. Write the one sentence they must take away. This becomes the top line of the document.
4. Draft the document front-loaded: conclusion first, evidence second, background last.
5. Rewrite every heading to state the answer, not the topic. Bad: "Authentication". Good: "Auth fails when the clock is more than 60s ahead".
6. Cut hedges. Replace "probably", "might", "consider", "we think" with direct statements. If you are not sure, say "we verified" or "we assume" and which.
7. Rewrite passive voice where the actor matters. "The token is validated" becomes "The middleware validates the token".
8. For every command shown, include the expected output and the next action if the output differs.
9. Read the draft out loud. If a sentence is hard to say, it is hard to read.

## Output format
\`\`\`markdown
# <heading stating the answer>

<one-paragraph summary of the answer, not the topic>

## <section heading stating the sub-answer>
<content>

### Command
\\\`\\\`\\\`bash
<exact command>
\\\`\\\`\\\`
Expected output:
\\\`\\\`\\\`
<expected>
\\\`\\\`\\\`
If different: <next action>
\`\`\`

## Anti-patterns
- "In order to" → "to". "It should be noted that" → delete.
- "Very", "really", "quite", "somewhat" — hedges, not information.
- Placeholder paths like \`<your-path-here>\` when a real example would work.
- "See the following sections" — let the reader scan headings themselves.
- "As mentioned above" — forward references only.
- A heading like "Introduction" — every first paragraph is an introduction.

## Depth signal
If the one-sentence takeaway does not fit on one line after three edits, the document is about too many things. Split it.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 9. incident-response
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.incident-response",
    slug: "incident-response",
    name: "Incident response",
    description:
      "On-call playbook: observe → stabilize → diagnose → fix → postmortem. Prioritizes customer impact over root cause during the active window.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "slash",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["shell_exec", "grep", "file_read", "http_fetch"],
    markdown: md`
---
name: incident-response
description: Active-incident playbook, stabilize before diagnose
version: 2.0.0
trigger: slash
allowed_tools: [shell_exec, grep, file_read, http_fetch]
---

# Incident response

During an active incident, root cause analysis is the wrong goal.
Users are bleeding. The right goal is to stop the bleeding, even if the
cause is still a mystery. A half-fixed incident with a pristine root
cause writeup is worse than a rolled-back incident with open questions.

## When to use
- Alert fired and service is user-visibly broken.
- User reports "everything is down" or "lots of errors".
- SLO burn rate is above threshold.
- A deploy just shipped and the error rate spiked within 10 minutes.
- You are paged in the middle of the night.

## When NOT to use
- The issue is a slow bug affecting one user — use debugging.
- Performance degradation without user impact — use performance-profiling.
- Scheduled maintenance window — follow the runbook, not this skill.
- You are the second responder and the first has it handled.

## Process
1. Open an incident channel and post the symptom verbatim from the pager. Expected output: team visibility.
2. Observe. Run \`kubectl -n prod get pods\`, check the error-rate dashboard, check the user-reports queue. Answer: what do users actually experience, when did it start, how many are affected.
3. Correlate with recent changes. \`git log --since="30 minutes ago" --all\` and the deploy history. Expected output: any candidate commits.
4. Pick a stabilization action with the highest relief per risk: rollback, feature-flag off, scale out, failover, maintenance mode. Narrate the action in channel before executing.
5. Execute the action. Watch the dashboard. Expected output: error rate falls toward baseline within 5 minutes.
6. If no relief, pick the next action in the list. Do not try two at once — you will not know which worked.
7. Declare all-clear only when: error rate at baseline for 15 minutes, no new user reports for 10 minutes, dashboards green.
8. Hand off to the next on-call if the shift is ending, with a written status in the channel.
9. After the incident closes, schedule the postmortem within 24 hours. Use the postmortem skill.

## Output format
\`\`\`
## Incident: <short title>
**Started:** <timestamp>
**Declared stable:** <timestamp>
**User impact:** <who, how many, what they saw>

## Timeline (UTC)
- T0  <pager fired>
- T+2m <observation>
- T+5m <action: rollback of abc123>
- T+8m <error rate returning to baseline>
- T+23m <all-clear>

## Stabilization action
<what was done and why>

## Follow-up
- [ ] Postmortem within 24h (owner: <name>)
- [ ] Verify <metric> at baseline for next full business cycle
\`\`\`

## Anti-patterns
- "Let me try one more thing" when a rollback is ready and waiting.
- Deploying experimental fixes to production during an active incident.
- Arguing about whose fault it is while users are broken.
- Deleting logs "to save space" — those logs are the postmortem.
- Skipping the channel narration — the next responder has no context.

## Depth signal
If 20 minutes pass with no stabilization action chosen, escalate to a senior incident commander. Indecision is worse than a wrong rollback.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 10. sql-optimization
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.sql-optimization",
    slug: "sql-optimization",
    name: "SQL optimization",
    description:
      "Performance tuning for slow queries. Starts with EXPLAIN, not with adding indexes. Knows when an index hurts more than it helps.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "slash",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["shell_exec", "file_read"],
    markdown: md`
---
name: sql-optimization
description: Measure-first query tuning, no blind index additions
version: 2.0.0
trigger: slash
allowed_tools: [shell_exec, file_read]
---

# SQL optimization

Most "slow query" fixes add an index, pray, and walk away. Half the
time the index is never used; the other half it silently slows every
write on the table. This skill forces EXPLAIN ANALYZE first, a named
bottleneck second, and an index only when the plan confirms it helps.

## When to use
- A query is measurably slow — user waits, timeout, dashboard red.
- \`pg_stat_statements\` or equivalent shows a query eating total time.
- An endpoint p95 regressed and tracing points at one query.
- Before merging a new query to a large table.
- After a schema change that invalidated the old plan.

## When NOT to use
- Query runs once a week for an analyst — sequential scan is fine.
- You have not measured with realistic data — optimizing against 100 dev rows is theater.
- The bottleneck is network or application, not SQL — profile the right layer.
- Table is write-heavy and already has 8+ indexes — adding one will make writes worse.

## Process
1. Capture the slow query verbatim with real parameter values. Expected output: the query as sent to the server.
2. Run \`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) <query>\` against a dataset that matches production shape and size. Expected output: the plan with actual timings.
3. Look for the slowest node in the plan. Common culprits: Seq Scan on a large table, Nested Loop with row estimate off by 10x, Sort without index support, Hash Join spilling to disk.
4. If the row estimate is wildly wrong, run \`ANALYZE <table>\` to refresh stats and re-run step 2. Expected output: estimates close to actual.
5. Classify the bottleneck:
   - Seq scan on filter column → add index.
   - Wrong index picked → rewrite WHERE or add a multi-column index.
   - ORDER BY + LIMIT scanning too much → index must match sort direction.
   - OFFSET on huge table → switch to keyset pagination.
   - SELECT * → narrow column list, especially for TOAST columns.
   - Correlated subquery in SELECT → rewrite as JOIN.
6. Apply exactly one change. Do not batch.
7. Run EXPLAIN ANALYZE again. Expected output: the slow node is gone or reduced.
8. In production, create indexes with \`CREATE INDEX CONCURRENTLY\` to avoid locking. Watch \`pg_stat_progress_create_index\`.
9. Verify the new plan is stable over 24 hours with \`pg_stat_statements\`.

## Output format
\`\`\`
## Query
<SQL with params>

## Baseline
EXPLAIN ANALYZE top node: <Seq Scan|Nested Loop|etc>
Actual time: <ms>
Rows: <actual/estimated>

## Bottleneck
<one sentence naming the slow node and why>

## Change
<rewrite or index DDL>

## After
EXPLAIN ANALYZE top node: <...>
Actual time: <ms>
Delta: -<X>%
\`\`\`

## Anti-patterns
- \`WHERE fn(col) = X\` — kills the index. Rewrite to bare column.
- \`OR\` across different columns — planner gives up. Rewrite as UNION.
- \`NOT IN (subquery)\` with NULL-able column — returns nothing. Use NOT EXISTS.
- Adding an index without checking existing ones — duplicates cost writes.
- "The query is faster now" without numbers — no number, no claim.

## Depth signal
If three index attempts have not improved the plan, the bottleneck is not the index. Step back and look at query shape, column selection, or schema design.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 11. api-design
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.api-design",
    slug: "api-design",
    name: "API design",
    description:
      "Designs HTTP APIs that age well: consistent naming, versioning, idempotency, error shapes. Every endpoint decision has a rationale.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "slash",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "file_write"],
    markdown: md`
---
name: api-design
description: HTTP API design focused on decisions that cannot be reversed
version: 2.0.0
trigger: slash
allowed_tools: [file_read, file_write]
---

# API design

Most API design decisions are cheap to make and expensive to change.
A resource named \`user\` (singular) or a status code returned as 200
with \`{ok: false}\` lives forever because clients compile it into their
code. This skill focuses attention on the irreversible decisions first.

## When to use
- New endpoint being added to a public or internal API.
- A refactor that changes an existing endpoint shape.
- A disagreement about naming, versioning, or error handling.
- Before writing the OpenAPI spec or route handler.
- When a second consumer is about to integrate with an API designed for one.

## When NOT to use
- Internal RPC between two services that ship together — use function calls.
- A one-off script endpoint nobody else will ever call.
- A refactor that only touches implementation, not the wire shape.
- The user wants a working prototype, not a long-lived API.

## Process
1. Name the resource and the operations. Plural nouns for collections (\`/users\`), kebab-case (\`/api-keys\`), verbs in the HTTP method not the path.
2. Version the path, not the header: \`/v1/users\`. Header versioning breaks caching, curl, and shareable URLs.
3. Design the request shape. Required fields, types, validation rules, size limits. Write it as JSON schema or TypeScript types.
4. Design the response shape. Same shape for success and error? Pagination fields? Include a \`next_cursor\` for any list that can grow unbounded.
5. Pick status codes from the standard set. 400 malformed, 401 unauthenticated, 403 authenticated-but-forbidden, 404 not found or not authorized to see, 409 conflict, 422 semantically invalid, 429 rate-limited, 500 server fault, 503 retryable. Do not invent new ones.
6. Design the error body. \`{ "error": "code_snake_case", "message": "...", "detail": {} }\` — one shape across every endpoint.
7. Decide idempotency. Any request with a side effect (charge, email, create) must accept \`Idempotency-Key\`. Store key+result for 24h so retries do not double-execute.
8. Decide pagination. Cursor-based for unbounded lists, cap \`limit\` server-side, always return \`next_cursor\` even when empty.
9. Document the rationale for every decision that differs from an existing endpoint. The next person will ask.
10. Plan the breaking-change protocol: ship v2 alongside v1, announce sunset in \`Deprecation\` header, email clients, wait 3 months, turn off v1.

## Output format
\`\`\`yaml
# /v1/users — POST
description: Create a user.
auth: Bearer <token>
idempotency: required (Idempotency-Key header)
rate_limit: 60/min/tenant

request:
  Content-Type: application/json
  body:
    email: string, RFC 5322
    name: string, 1-100 chars

responses:
  201:
    body: { id, email, name, created_at }
  400:
    body: { error: "invalid_email", message, detail: { field: "email" } }
  409:
    body: { error: "user_exists", message, detail: { email } }
  429:
    body: { error: "rate_limited", message, detail: { retry_after_seconds } }

rationale:
  - Path is /v1 not header-versioned: cacheable, curl-friendly.
  - 409 chosen over 422 because email uniqueness is a server-state conflict.
\`\`\`

## Anti-patterns
- 200 status with \`{ok: false}\` in the body — breaks every client library.
- Returning different shapes for the same endpoint based on a query flag.
- Removing a field in v1 after launch — add new fields only, break in v2.
- Singular resource names (\`/user/:id\`) inconsistent with plural collections.
- \`POST /createUser\` — verbs go in the method.
- Inventing a 3-digit status code not in RFC 7231.

## Depth signal
If the endpoint needs more than four \`if\`-style variants in the request body, split it into multiple endpoints. Overloaded endpoints age badly.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 12. meeting-notes
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.meeting-notes",
    slug: "meeting-notes",
    name: "Meeting notes",
    description:
      "Turns a rambling discussion into decisions, action items, and open questions. Optimized for people who weren't in the room.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "slash",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: [],
    markdown: md`
---
name: meeting-notes
description: Decision-focused notes for people who were not in the room
version: 2.0.0
trigger: slash
allowed_tools: []
---

# Meeting notes

Transcript-style notes ("Alice said X, Bob replied Y") fail their
primary job: letting someone who was not in the meeting learn the
outcome without re-doing the meeting. This skill extracts decisions,
action items, and open questions from a messy discussion.

## When to use
- User pastes raw meeting transcript or bullet dump.
- User says "write up the meeting", "summarize the call", "action items".
- After a design review, retro, or planning session.
- Any discussion where absent stakeholders must be informed.
- Before sending a follow-up email to the room.

## When NOT to use
- Casual 1:1 conversation with no decisions made.
- Status update calls where nothing new emerged — one-line summary is enough.
- User wants a verbatim transcript, not notes. That is a different task.
- Confidential discussions where notes themselves are a risk.

## Process
1. Read the whole transcript before writing anything. Mark passages that contain decisions, action items, and unresolved questions.
2. Extract decisions. A decision is a statement the team agreed to act on. For each: name it, attribute it to an owner, capture the rationale in one sentence.
3. Extract action items. Every item needs a single named owner (not "team"), a verb, and a deadline (not "soon").
4. Extract open questions. Anything discussed but not resolved. Flag which decisions or actions depend on each question.
5. Write the TL;DR: 2-3 sentences covering what was decided and what happens next.
6. Write the attendees block. Include the "absent but should have been there" list — this is how escalation happens later.
7. Attach the raw discussion as a final "Notes" section for anyone who wants context. Do not remove it.
8. Send within 1 hour. Notes sent the next morning are half-forgotten and half-wrong.

## Output format
\`\`\`markdown
# <topic> — <YYYY-MM-DD>

**Attendees:** <names>
**Absent (relevant):** <names who should have been there>

## TL;DR
<2-3 sentences: what was decided, what happens next>

## Decisions
- <decision> — owner: @name — rationale: <one sentence>

## Action items
- [ ] @name will <verb> <thing> by <YYYY-MM-DD>

## Open questions
- <question> — blocks: <decision or action> — needed by: <date>

## Notes
<raw discussion, chronological>
\`\`\`

## Anti-patterns
- "Team will look into it" — name one person or drop the item.
- "Decided to move forward" — with what exactly?
- Action items with no deadline — they will not happen.
- Silently dropping the unresolved questions — they become surprise blockers.
- Editorializing inside the Notes section — keep interpretation in TL;DR.
- Sending the notes 48 hours later — the room has already moved on.

## Depth signal
If you extract zero decisions from a 60-minute meeting, flag that in the TL;DR. A meeting without decisions is a meeting worth questioning.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 13. customer-support
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.customer-support",
    slug: "customer-support",
    name: "Customer support replies",
    description:
      "Empathetic, specific replies to user issues. Never blames the user, never escalates without a reason, always has a next step.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "auto",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: [],
    markdown: md`
---
name: customer-support
description: Empathetic, specific support replies with a clear next step
version: 2.0.0
trigger: auto
allowed_tools: []
---

# Customer support replies

A generic "sorry you are having trouble, our team is working on it"
reply signals to the user that nobody read their message. That is
worse than no reply at all. This skill produces replies that quote the
specific failure, state what is known, and commit to a next step.

## When to use
- Drafting a reply in a support ticket, email, or live chat.
- Rewriting an internal engineer's draft to be user-facing.
- Responding to a complaint about a bug, outage, or billing issue.
- Following up on an escalation the user has not heard back on in 4+ hours.
- Writing the "holding" reply while investigation continues.

## When NOT to use
- Internal engineer-to-engineer comms — use normal technical voice.
- Legal threats requiring a template reviewed by legal — do not improvise.
- Auto-generated system notifications (password reset, receipt) — those are templates.
- Spam or abuse — use moderation workflow, not a reply.

## Process
1. Read the full message. Identify the specific failure in the user's words. Quote it back in the acknowledgement.
2. Check what is actually known. Was the user's report confirmed? What is the current status? Do not guess.
3. Decide the next step: a fix ETA, a diagnostic question, a workaround, or an escalation.
4. Draft the reply in four parts: specific acknowledgement, what is known, next step, follow-up commitment.
5. Match the user's tone one notch friendlier. Formal email → formal reply. Casual chat → casual reply.
6. Strip forbidden phrases: "unfortunately", "as you know", "per our last email", "please be patient", "our team is working on it" (unless you say what on).
7. Check the escalation triggers: words meaning legal (sue, lawyer, press), words meaning lost money (charged twice, fraud, billing), known enterprise account missing SLA, you cannot answer in 15 minutes.
8. If any trigger fires, escalate with the user's ticket link and a one-paragraph context note to the right team.
9. Send, then set a reminder for the follow-up time you committed to.

## Output format
\`\`\`
Hi <name>,

<specific acknowledgement quoting the failure>

<what we know, plain language, no jargon>

<what we are doing next OR what they can do right now>

I will check back <specific time, e.g. "by 5 PM KST today">.

— <your name>, YUA support
\`\`\`

## Anti-patterns
- "Sorry for the inconvenience" — too generic to read as sympathy.
- "This is a known issue" with no ticket link or ETA — sounds like a brush-off.
- "There is nothing I can do" — there is always an escalation path.
- Using the customer's name in every paragraph — it reads as a script.
- Asking the user to repeat information already in their ticket.
- Closing the ticket without a follow-up time.

## Depth signal
If you cannot commit to a specific follow-up time in the reply, escalate to a supervisor. "I will get back to you soon" is not a commitment.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 14. security-audit
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.security-audit",
    slug: "security-audit",
    name: "Security audit",
    description:
      "Targeted threat modeling of a codebase slice. Focuses on OWASP Top 10 + auth boundaries. Outputs severity-ranked findings with reproducible PoCs.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "slash",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "grep", "shell_exec"],
    markdown: md`
---
name: security-audit
description: Targeted audit of a codebase slice with reproducible findings
version: 2.0.0
trigger: slash
allowed_tools: [file_read, grep, shell_exec]
---

# Security audit

A full-repo audit produces a wall of low-severity noise and misses the
one auth bypass. A targeted audit of a named flow, walked in the OWASP
order, finds the things that actually get people fired. The risk of
skipping: a critical vulnerability ships to production unreviewed.

## When to use
- A new feature touches auth, payments, PII, or file upload.
- Before a SOC2 / PCI / HIPAA review milestone.
- After a dependency CVE disclosure that might affect this code.
- Before exposing an internal endpoint to the public internet.
- User asks "is this secure", "audit this flow", "review for vulns".

## When NOT to use
- Whole-repo request — pick one flow and audit it properly.
- Code already being rewritten this sprint — audit the new version.
- Style issues or code quality — use code-review.
- Theoretical bugs with no reproduction path — downgrade or drop.

## Process
1. Name the scope in one sentence: "Audit the workspace invite flow from API gateway through Postgres write." If you cannot name it, stop and ask.
2. List every route in scope with \`grep -nE 'router\\.(get|post|put|delete|patch)' <files>\`. Expected output: enumerated handlers.
3. Authentication walk. For each handler, confirm \`requireFirebaseAuth\` (or equivalent) is in the middleware chain. Missing = Critical.
4. Authorization walk. For each handler that reads \`req.user\`, confirm it also checks the user owns or has a role on THIS resource. Missing = High (horizontal priv-esc).
5. Injection walk. \`grep -nE '\\.query\\(|exec\\(|child_process|innerHTML|eval\\(|\\$\\{' <files>\`. For each hit verify the input is parameterized. Any string-concat into SQL / shell / template = Critical.
6. Secrets walk. \`grep -rnE '(sk_|AKIA|ghp_|-----BEGIN|api[_-]?key\\s*=\\s*["\\x27][A-Za-z0-9])' <dir>\` and \`git log -p -S "<suspicious string>"\`. Any hit = Critical, even in tests.
7. Deserialization walk. \`grep -nE '(JSON\\.parse|yaml\\.load|pickle\\.loads)' <files>\`. Input from the network requires a schema validator before parsing. YAML especially.
8. SSRF walk. \`grep -nE 'fetch\\(|axios\\(|http\\.get' <files>\`. If the URL is user-controlled, require allowlist or SSRF proxy. Missing = High.
9. XSS walk. \`grep -nE 'innerHTML|dangerouslySetInnerHTML|v-html|\\$\\{' <templates>\`. Every user input rendered into HTML must pass through an encoder. Missing = High (stored) or Medium (reflected).
10. Rate-limit walk. For every endpoint that costs money, sends email, or spawns work, confirm a rate limiter. Missing = Medium.
11. Logging walk. \`grep -nE 'logger\\.(info|warn|error)\\(.*(?:token|password|email|ssn)' <files>\`. Any hit = Medium and mandatory redaction.
12. For each finding, build a reproducible PoC: exact curl command, exact payload, exact expected and actual responses.

## Output format
\`\`\`
### <finding title>
**Severity:** Critical | High | Medium | Low
**Location:** <file>:<line>
**Impact:** <what an attacker gains>
**Reproduction:**
\\\`\\\`\\\`bash
curl -X POST http://localhost:4000/... -H ... -d ...
\\\`\\\`\\\`
**Expected:** <safe response>
**Actual:** <unsafe response>
**Fix:** <specific change: parameterized query / require role check / sanitize with X>
\`\`\`

## Anti-patterns
- "Should probably use prepared statements" — it is required, not optional.
- "An attacker might be able to" — demonstrate it or downgrade severity.
- "Fix: sanitize input" — name the sanitizer and the call site.
- Reporting style issues as security findings — use code-review instead.
- Claiming a Critical without a PoC — downgrade until you have one.

## Depth signal
If the scope contains more than 10 handlers or 2000 lines, split into multiple audits. Broad sweeps miss subtle bugs.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 15. refactoring
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.refactoring",
    slug: "refactoring",
    name: "Refactoring",
    description:
      "Restructures code without changing behavior. Tests stay green the whole time. Knows when a refactor is actually a rewrite in disguise.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "slash",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "file_write", "grep", "shell_exec"],
    markdown: md`
---
name: refactoring
description: Behavior-preserving restructuring with tests green the entire time
version: 2.0.0
trigger: slash
allowed_tools: [file_read, file_write, grep, shell_exec]
---

# Refactoring

A refactor that drops tests while "cleaning things up" is a rewrite
wearing a refactor's name tag, and it ships silent behavior changes.
The discipline of this skill is: tests stay green the entire time,
changes stay small, and anything that cannot meet those rules is
renamed to "rewrite" and replanned.

## When to use
- Two or more call sites share 5+ identical lines (extract function).
- A variable name no longer matches what it holds (rename).
- A function takes 6+ arguments (introduce parameter object).
- A type field branches behavior 3+ ways (replace conditional with polymorphism).
- A planned feature needs an interface that the current code obstructs.

## When NOT to use
- Tests do not exist for the code being touched. First commit must add tests.
- You are in a hurry to ship a feature. Refactor later.
- The code is not on the path of any planned change and nobody has asked.
- The change touches the public API of a module — that is a rewrite.
- You cannot run the full test suite locally — defer until you can.

## Process
1. State the single specific reason for the refactor. "It is messy" is not a reason. "I need to reuse this logic from two call sites" is. Write it down.
2. Confirm test coverage on the target code. Run \`pnpm test <file>\` and check the coverage report. If coverage is under 80 percent on the target, stop and write tests as a separate commit first.
3. Pick the smallest possible change (rename, extract, inline). No more than 10 lines per step.
4. Apply the change.
5. Run the tests. \`pnpm --filter <pkg> test\`. Expected output: all green. If red, revert immediately and try a smaller step.
6. Commit with a \`refactor:\` prefix and a message describing the single change.
7. Return to step 3 until the reason from step 1 is satisfied.
8. At the end, run the full test suite one more time. Expected output: all green, including tests you did not touch.
9. Compare the public API before and after. If it changed, this was a rewrite and needs a different review.

## Output format
\`\`\`
## Refactor goal
<one sentence matching step 1>

## Commits
1. refactor: rename <x> to <y>
2. refactor: extract <f> from <caller>
3. refactor: inline <g>
...

## Test status
Before: <X> tests green
After:  <X> tests green (same count, same names)

## API surface diff
<empty — this is the whole point>
\`\`\`

## Anti-patterns
- A 200-line "refactor" commit — it is a rewrite with a misleading label.
- Renaming a database column and calling it a refactor.
- Switching libraries (ORM, HTTP client) and calling it a refactor.
- "Also fix this small bug while I am in there" — separate commit, separate review.
- Running tests only at the end — you will not know which step broke them.

## Depth signal
If a single refactor step drops a test from green to red, stop the whole effort. You have been editing behavior without noticing, and the next step will make it worse.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 16. runbook
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.runbook",
    slug: "runbook",
    name: "Runbook authoring",
    description:
      "Writes ops runbooks for on-call responders. Every step is copy-paste runnable, every decision point has expected output and a next branch.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "slash",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "file_write"],
    markdown: md`
---
name: runbook
description: On-call runbook with copy-paste commands and branching decisions
version: 2.0.0
trigger: slash
allowed_tools: [file_read, file_write]
---

# Runbook authoring

A runbook that tells the 3am on-call "check the queue size" has failed
its job. The responder does not know which queue, which host, or what
healthy means. This skill produces runbooks where every command is
copy-paste ready and every decision point has expected output plus
the next branch.

## When to use
- A new alert or scenario needs documented response steps.
- After an incident that would have resolved faster with a runbook.
- A service is being handed off to another team.
- Before onboarding a new on-call engineer to a service.
- Existing runbook rotted — update it as part of the postmortem follow-up.

## When NOT to use
- The scenario has never happened and cannot be forecasted — do not guess.
- The fix is so rare that documenting it costs more than rediscovering it.
- The service is being deprecated within 30 days.
- The step requires judgment no runbook can encode — link to a human owner.

## Process
1. State the trigger. Quote the alert name or scenario in exact words. "Alert: yua-engine RSS > 80 percent for 5 minutes".
2. State the user impact. Who is affected, what they cannot do, how to recognize it from user reports.
3. Write the "am I in the right runbook" check. 1-2 commands that distinguish this alert from similar ones. Expected output = this alert. Otherwise link to the adjacent runbook.
4. Write the quick fix. The one command that usually works. Full command with real arguments. Include the expected output so the responder knows it worked.
5. Write the fallback tree. If the quick fix fails, the next step with its own expected output. Branch on the output, not on a feeling.
6. Write escalation. Who to page if N minutes pass with no progress, with the pager command or link.
7. Write "related alerts" links. List the runbooks most often confused with this one.
8. Test it. Walk someone who has never seen it through the steps in a staging environment. If they stall, the runbook is broken.
9. Sign and date the file. Runbooks without ownership rot fastest.

## Output format
\`\`\`markdown
# <service> — <alert or scenario>
**Owner:** <team>  **Last verified:** <YYYY-MM-DD>  **Last incident:** <YYYY-MM-DD>

## Symptom
<exact alert text or user report>

## Impact
<who, what they cannot do>

## Am I in the right runbook?
\\\`\\\`\\\`bash
kubectl -n prod get pods -l app=<svc>
\\\`\\\`\\\`
Expected: N/N pods Running. If 0/N, this is the correct runbook. If N/N, check <other runbook>.

## Quick fix
\\\`\\\`\\\`bash
kubectl -n prod rollout restart deploy/<svc>
\\\`\\\`\\\`
Expected within 90s:
\\\`\\\`\\\`
deployment.apps/<svc> restarted
<N> pods Running
\\\`\\\`\\\`

## If the quick fix does not work
1. Check node pressure:
   \\\`\\\`\\\`bash
   kubectl describe node <node>
   \\\`\\\`\\\`
   If MemoryPressure: True → go to "Node under pressure" runbook.
2. ...

## Escalation
Page <team> via <pager link> after 15 minutes of no progress.

## Related alerts
- <alert name> — <runbook link>
\`\`\`

## Anti-patterns
- "Check the queue size" — which queue, on which host, what is healthy.
- "If it looks wrong, restart" — define wrong in terms of command output.
- Runbook that assumes the responder knows the architecture.
- Commands with placeholder hostnames the responder must guess.
- Runbook with no "last verified" date — impossible to trust.

## Depth signal
If after two incidents the runbook still does not match reality, schedule a 1-hour review with the on-call rotation rather than patching symptoms.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 17. a11y-audit
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.a11y-audit",
    slug: "a11y-audit",
    name: "Accessibility audit",
    description:
      "Audit a UI change for WCAG 2.2 AA compliance. Focuses on keyboard reach, name/role/value, contrast, and live-region noise.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "manual",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "grep", "search"],
    markdown: md`
---
name: a11y-audit
description: WCAG 2.2 AA audit of a UI change with blocker/non-blocker split
version: 2.0.0
trigger: manual
allowed_tools: [file_read, grep, search]
---

# Accessibility audit

Accessibility is a correctness property, not a polish pass. A button
a keyboard user cannot reach is broken the same way a 500 error is
broken. Skipping this skill ships UI that excludes real users and
exposes the product to legal risk in jurisdictions with binding a11y
laws.

## When to use
- A PR that adds or changes any interactive element.
- New form, modal, dropdown, or custom widget.
- Color or theme change that might affect contrast.
- A change to focus management or tab order.
- Before shipping any page to production for the first time.

## When NOT to use
- Backend-only change with no rendered output.
- Internal debug tool used by three engineers — note the exemption in the PR body.
- Pure asset swap (image with identical alt text) — spot check only.
- Auto-generated pages where fixes must happen in the generator, not the output.

## Process
1. Tab through the flow with the keyboard only. Start from URL bar, Tab repeatedly. Every interactive element must receive focus. Focus indicator must be visible. Tab order must match visual order.
2. If Tab reaches an element that does nothing on Enter/Space, that is a blocker.
3. Open a screen reader on one page (VoiceOver on macOS, NVDA on Windows). Every control must announce name + role + current value. If a button announces "button" with no name, that is a blocker.
4. Check color contrast using a tool (axe DevTools, WAVE, Contrast Checker). Body text 4.5:1 minimum, large text 3:1, non-text UI 3:1. Cite the failing pair.
5. Resize text to 200 percent in browser zoom. No clipped content, no horizontal scroll on a 1280px viewport.
6. Toggle \`prefers-reduced-motion\`. Any transform or opacity animation longer than 200ms must be disabled or shortened.
7. Grep the JSX for known broken patterns: \`grep -nE '(onClick=.*<div|aria-label=""|tabIndex=["\\x27][1-9])' <files>\`. Expected output: zero hits.
8. For each finding, cite file:line, the WCAG criterion, and the concrete fix.
9. Split findings into Blocking (must fix before merge) and Non-blocking (file a ticket).

## Output format
\`\`\`
## Blocking issues (must fix before merge)
- [<file>:<line>] <issue> — WCAG <criterion> — fix: <specific change>

## Non-blocking issues (track in a ticket)
- [<file>:<line>] <issue> — <why non-blocking>

## Verified good
- <thing you checked that passed, so scope is clear>
\`\`\`

## Anti-patterns
- \`<div onClick>\` acting as a button. Use \`<button>\`.
- Icon-only buttons without \`aria-label\`.
- \`placeholder\` used as the only label for an input.
- \`tabindex\` values of 1, 2, 3 — only 0 and -1 are legal.
- Toast notifications without \`role="status"\` or \`aria-live\`.
- Modals that do not trap focus or restore focus on close.
- Color as the only signal for errors or required fields.
- "Screen readers can skip it" without testing with a screen reader.

## Depth signal
If three or more blockers appear in one component, request a design review before fixing. The component is probably fighting the accessibility tree, not missing labels.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 18. cost-optimization
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.cost-optimization",
    slug: "cost-optimization",
    name: "Cloud cost optimization",
    description:
      "Find and rank cost reduction opportunities in a cloud bill or infra config. Attaches a dollar estimate and a risk rating to each recommendation.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "manual",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "grep", "search"],
    markdown: md`
---
name: cost-optimization
description: Rank cloud cost reductions with dollar estimate and risk rating
version: 2.0.0
trigger: manual
allowed_tools: [file_read, grep, search]
---

# Cloud cost optimization

A cost review that produces "turn off unused things" is not actionable.
A cost review that produces "these three changes save USD 1,200 per
month at low risk, these two save USD 4,000 per month with a
maintenance window" is actionable. The risk of skipping: silent
overspend on idle compute and abandoned staging envs.

## When to use
- Monthly bill increased more than 20 percent and nobody knows why.
- User says "cut cloud spend", "optimize cost", "why is our bill so high".
- Before renewing a committed-use discount or reserved instance.
- After a major feature ship that changed the workload shape.
- When finance asks for a six-month savings plan.

## When NOT to use
- Total spend under a few hundred dollars per month. Engineer time costs more than savings.
- During a launch or migration — the baseline is unstable.
- When the user wants free-tier fit for a personal project — that is product selection, not optimization.
- Before the workload has 14 days of stable metrics.

## Process
1. Pull the last 30 days of bill data broken down by service and region. If the user has not shared it, ask for the export.
2. Identify the top 5 line items. Sort by dollar amount, not by percent. A 2 percent line item on a 10k bill is still only 200 USD.
3. Idle compute check. Find instances with CPU under 10 percent p95 over 14 days. Downsize one tier or set autoscale minimum lower. Risk: low if workload is stateless, medium if stateful.
4. Unattached disks and stale snapshots. Anything untouched for 30 days. Risk: low after verifying no mount references.
5. Object storage lifecycle. Check buckets for missing lifecycle policies. Propose moving cold data to infrequent-access or archive tier. Compute savings per bucket.
6. Egress audit. \`grep\` for cross-region or public-internet egress. Common fix: VPC endpoint or same-region move.
7. Log volume. Check verbose application log level in production. Info-level logs at 10GB/day are a standard surprise line. Switching to warn cuts 70 percent typically.
8. Non-prod 24/7. Find dev / staging environments running every night and weekend. Schedule stop at 19:00, start at 09:00 weekdays. Risk: low if the team can re-wake on demand.
9. For each recommendation, compute monthly dollar estimate. Without an estimate, drop it.
10. Group by effort: one-click, one-hour, one-week. Rank within each by dollars saved.

## Output format
\`\`\`
## Summary
Current spend: USD <X>/month.
Identified savings: USD <Y>/month at low risk, USD <Z>/month with planned changes.

## Immediate (low risk, one-click)
1. <change> — saves ~USD <N>/month — risk: low
   Why safe: <reason>
   Command: <concrete action>

## Next sprint (medium effort)
1. <change> — saves ~USD <N>/month — risk: medium
   Why safe: <reason>
   Plan: <one sentence>

## Needs design review (high impact, needs planning)
1. <change> — saves ~USD <N>/month — risk: high
   Constraint: <why it needs review>
\`\`\`

## Anti-patterns
- Recommending reserved instances before 18 months of stable usage data.
- Downsizing production databases without a p95/p99 latency baseline.
- Deleting snapshots tagged with a retention policy the user did not read.
- "Turn off unused services" with no definition of unused.
- Recommendations with no dollar estimate — pad that does not help decisions.

## Depth signal
If the top 3 recommendations together save less than 5 percent of the bill, stop. The workload is already well-tuned and your time is better spent elsewhere.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 19. dependency-audit
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.dependency-audit",
    slug: "dependency-audit",
    name: "Dependency audit",
    description:
      "Audit third-party dependencies for vulnerabilities, abandonment, license drift, and supply-chain risk. Produces an actionable upgrade list.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "manual",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "shell_exec", "grep", "search"],
    markdown: md`
---
name: dependency-audit
description: Audit deps for CVEs, abandonment, license drift, and typosquats
version: 2.0.0
trigger: manual
allowed_tools: [file_read, shell_exec, grep, search]
---

# Dependency audit

Most supply-chain incidents arrive through a transitive dependency
nobody on the team has heard of. The raw output of \`npm audit\` is
noise — most CVEs do not apply to your call paths. This skill triages
the noise and leaves a short list of decisions for a human.

## When to use
- Before a security review or compliance milestone.
- A dep was flagged by GitHub Dependabot or Snyk.
- Quarterly hygiene cycle on a long-lived codebase.
- After discovering an abandoned package in the tree.
- Before exposing a service to the public internet for the first time.

## When NOT to use
- Right before a production freeze — upgrades need test cycles.
- During an active incident — wrong priority.
- On a codebase being deprecated within 60 days.
- When there is no lockfile — fix that first, then audit.

## Process
1. Pin check. Every direct dependency must have an exact or compatible range, never \`*\` or \`latest\`. \`grep -nE '"[^"]+":\\s*"(latest|\\*)"' package.json\`. Expected output: zero hits.
2. Lockfile check. Confirm a lockfile exists and is committed. \`git ls-files | grep -E '(pnpm-lock\\.yaml|package-lock\\.json|yarn\\.lock)'\`. Expected: one result.
3. CVE scan. Run \`pnpm audit --audit-level=high\` (or \`npm audit\`, \`pip audit\`, \`cargo audit\`). Capture output verbatim.
4. For each CVE reported, check the callsite. If the vulnerable function is never called from your code, downgrade to "accept and document".
5. Abandonment scan. For each direct dep, check last commit date and release cadence on the package registry. Anything with no release in 18 months is a risk even without a CVE.
6. License scan. \`pnpm licenses list\`. Flag any copyleft license (GPL, AGPL) that crept into a commercial product. Flag any dep with no license field.
7. Typosquat check. Compare direct dep names against the top downloads list for the ecosystem. \`reakt\`, \`expresss\`, \`lodahs\` are all real historical typosquats.
8. Triage the findings into three buckets with explicit rules below.

## Triage rules
- Critical CVE with known exploit and patched version available: upgrade before anything else, ship today.
- High CVE with no patched version: mitigate in config, document the acceptance, set ticket.
- Abandoned dep that is small and stable: note only.
- Abandoned dep that is large or touches auth / crypto / parsing: replace, this is a fire.
- Copyleft license in commercial code: legal escalation, not engineering decision.

## Output format
\`\`\`
## Must fix this week
- <pkg> <version>: <CVE> <severity> — upgrade to <safe version>
  Call path: <yes/no>, blast radius: <what uses it>
  Command: pnpm up <pkg>@<safe>

## Plan to replace this quarter
- <pkg>: <reason> — candidate replacements: <list>

## Accept and document
- <pkg>: <risk> — <mitigation> — owner: <name> — review date: <YYYY-MM-DD>

## License issues
- <pkg>: <license> — action: <legal review | remove>

## Clean
- <N> direct deps passed all checks
\`\`\`

## Anti-patterns
- Reporting every \`npm audit\` line as a must-fix without checking callsites.
- "Accept the risk" with no mitigation and no review date — that is just ignoring it.
- Upgrading a major version without reading the changelog.
- Replacing an abandoned dep with another abandoned dep.
- Running the audit without a lockfile — results are meaningless.

## Depth signal
If more than 10 direct deps land in "must fix this week", stop the audit and schedule a dedicated upgrade sprint. Piecemeal fixes will never catch up.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 20. dockerfile-review
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.dockerfile-review",
    slug: "dockerfile-review",
    name: "Dockerfile review",
    description:
      "Review a Dockerfile for image size, build-cache efficiency, reproducibility, and container security posture.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "manual",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "grep"],
    markdown: md`
---
name: dockerfile-review
description: Review a Dockerfile across size, cache, reproducibility, security
version: 2.0.0
trigger: manual
allowed_tools: [file_read, grep]
---

# Dockerfile review

A Dockerfile can pass every linter and still ship a 2GB image that
busts the cache on every commit, runs as root, and bakes in a secret.
This skill walks four axes — size, cache, determinism, attack
surface — and produces a review with concrete fixes.

## When to use
- A new Dockerfile is being added to the repo.
- An existing Dockerfile has not been reviewed in 6+ months.
- The image size has crept over 1GB.
- Build times on CI exceeded 5 minutes for a small code change.
- Before shipping a container to a public registry.

## When NOT to use
- Single-use dev containers. The review cost exceeds the payoff.
- Auto-generated Dockerfiles from tools like \`nixpacks\` or \`pack\` — those need a different review.
- Debug images intended for a one-time investigation.

## Process
1. Read the whole Dockerfile front to back before commenting.
2. Base image pinning. \`grep -nE '^FROM [^@]+$' Dockerfile\`. Expected output: zero hits (every FROM should include a digest like \`@sha256:...\`). Tag-only FROM = blocking.
3. Multi-stage. Count \`FROM\` directives. A runtime image that also contains compilers, dev headers, or package manager caches is a size bug. Single-stage build with dev deps = blocking on any production image.
4. Cache order. Verify dependency manifests are copied before source code. \`grep -n 'COPY' Dockerfile\` and read the order. Copying source before \`npm install\` busts cache on every code change.
5. Layer cleanup. For each \`RUN apt-get install\` verify it chains cleanup on the same line. A separate \`RUN rm -rf /var/lib/apt/lists/*\` only hides the files in the previous layer.
6. User. \`grep -n '^USER' Dockerfile\`. Missing = blocking. Running as root in production is unacceptable.
7. Secrets. \`grep -nE 'ARG.*(TOKEN|KEY|SECRET|PASS)' Dockerfile\` and check if any \`ARG\` is referenced in a \`RUN\` line that persists in a layer. BuildKit \`--mount=type=secret\` is the fix.
8. WORKDIR. \`grep -n '^WORKDIR' Dockerfile\`. Missing means relative paths rely on the base image default — fragile.
9. .dockerignore. Read the sibling file. Missing or empty means \`.git\`, \`node_modules\`, and local env files ship into the image.
10. Estimate before/after size. Explain which fixes change the size and by roughly how much.

## Output format
\`\`\`
## Blocking
- <line>: <issue> — fix: <specific change>
  Before:
    <line>
  After:
    <line>

## Strong suggestions
- <line>: <issue> — why: <reason>

## Observed good practices
- <things done right so the author knows what to keep>

## Estimated size impact
Before: ~<X> MB
After:  ~<Y> MB
Main contributors: <stage split, cache cleanup, etc>
\`\`\`

## Anti-patterns
- \`FROM node:latest\` — tag moves, builds become non-reproducible.
- Copying the entire repo before installing deps — cache bust on every commit.
- Running \`USER root\` in the final stage with no drop.
- Baking \`ARG DATABASE_URL\` into a layer — persists in image history.
- \`RUN apt-get update\` with no \`&& apt-get install\` on the same line — stale metadata.
- No \`.dockerignore\` while \`COPY . .\` is present.

## Depth signal
If the image is over 2GB after a review pass, the problem is architectural (wrong base, wrong language choice). Stop optimizing the Dockerfile and reconsider the runtime.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 21. git-bisect
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.git-bisect",
    slug: "git-bisect",
    name: "Git bisect workflow",
    description:
      "Drive a binary search through git history to find the commit that introduced a bug. Emphasizes writing a deterministic test script first.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "slash",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["shell_exec", "file_read"],
    markdown: md`
---
name: git-bisect
description: Binary-search git history with a deterministic test script first
version: 2.0.0
trigger: slash
allowed_tools: [shell_exec, file_read]
---

# Git bisect

Bisect is the strongest debugging tool when a behavior used to work
and now it does not. The failure mode is guessing — marking commits
good or bad based on intuition — which poisons the search and produces
the wrong answer. This skill forces a deterministic test script before
the search starts.

## When to use
- A behavior worked N days ago and does not work today.
- The regression is reproducible, not flaky.
- The suspected commit range is 10-2000 commits — too large to read, too small to rewrite.
- A test suite has a new failing test but the blame points at an unrelated refactor.
- You can write a one-command check that returns 0/non-zero reliably.

## When NOT to use
- You already understand the mechanism from reading the code.
- The bug is flaky — bisect will mislabel commits and lie to you.
- The regression depends on data that has since been deleted.
- The commit range spans a schema or dependency change that makes older commits unbuildable.
- You cannot write a deterministic test — fix that first or abandon bisect.

## Process
1. Lock down a repro. Same OS, same lockfile, same environment variables. Write the exact command that shows the bug.
2. Identify the known-good SHA. \`git log --oneline --since="2 weeks ago"\` and check out an old commit that the user remembers worked. Run the repro.
3. Write the test script. Must exit 0 for good, non-zero for bad, exit 125 for "cannot test this commit" (skip). Must complete in under a minute per iteration where possible. Must not depend on network unless the bug is a network bug.
4. Save the script as \`bisect-test.sh\`, \`chmod +x bisect-test.sh\`.
5. Verify the script on both ends. \`git checkout <known-good> && ./bisect-test.sh; echo $?\`. Expected: 0. \`git checkout <known-bad> && ./bisect-test.sh; echo $?\`. Expected: non-zero. If either is wrong, the script is wrong and bisect will fail silently.
6. Start bisect:
   \`\`\`
   git bisect start
   git bisect bad <known-bad>
   git bisect good <known-good>
   git bisect run ./bisect-test.sh
   \`\`\`
7. When bisect names a commit, do not trust it blindly. \`git show <sha>\` and read the diff. Confirm the mechanism matches the bug.
8. \`git bisect reset\` when done. Always. Otherwise the next git operation is confusing.

## Output format
\`\`\`
## Repro
<exact command that shows the bug>

## Test script
\\\`\\\`\\\`bash
#!/usr/bin/env bash
set -e
<build if needed>
<run the repro; exit 0 if fixed, non-zero if broken>
\\\`\\\`\\\`

## Range
good: <sha>  <date>  <subject>
bad:  <sha>  <date>  <subject>
range size: <N> commits

## Result
<sha> <subject>
Author: <name>, <date>
Mechanism: <one paragraph explaining WHY this commit broke the behavior>

## Fix direction
<revert | forward fix | root-cause fix in different file>
\`\`\`

## Anti-patterns
- Bisecting without verifying both endpoints first.
- Marking a commit "good" based on a visual inspection instead of the test script.
- Bisecting across a dependency lockfile change without resetting \`node_modules\` each iteration.
- Using \`git bisect run\` with a script that exits 1 on build failure — tell it to exit 125 instead.
- Trusting the named commit without reading the diff.

## Depth signal
If bisect returns a merge commit, re-run with \`git bisect start --first-parent\` to bisect only the trunk. If that still fails, the regression lives in the merge resolution and needs manual review.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 22. k8s-debugging
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.k8s-debugging",
    slug: "k8s-debugging",
    name: "Kubernetes debugging",
    description:
      "Diagnose a broken Kubernetes workload. Walks pod -> container -> node -> network in order, with the exact kubectl commands at each step.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "manual",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["shell_exec", "file_read"],
    markdown: md`
---
name: k8s-debugging
description: Layered pod → container → node → network diagnosis
version: 2.0.0
trigger: manual
allowed_tools: [shell_exec, file_read]
---

# Kubernetes debugging

Every broken workload gets debugged in the same layered order: pod
state, container logs, container runtime, node, network, control
plane. Skipping ahead — jumping to "it must be a network policy" —
wastes hours because the actual issue was an image pull error visible
in \`kubectl describe\` at step 1.

## When to use
- Pod stuck Pending, CrashLoopBackOff, ImagePullBackOff, or Running-but-not-Ready.
- Service returns 502/503 but app logs are fine.
- Deploy rolled out and new pods never went Ready.
- User says "it works on my laptop but not in the cluster".
- Alert fired on a Kubernetes-managed workload.

## When NOT to use
- The bug is in application logic — use debugging skill with the app's logs.
- The issue is a CI build failure, not a runtime failure.
- You do not have \`kubectl\` access — get access first.
- The cluster itself is down (control plane unreachable) — that is a different runbook.

## Process
1. State the symptom in one sentence: not "pods are crashing" but "readiness probe on orders-api fails with HTTP 500 within 30 seconds of startup".
2. Pod state. \`kubectl -n <ns> get pods -l app=<name> -o wide\`. Expected output: list with STATUS, RESTARTS, AGE, NODE. Read the STATUS column carefully.
3. Describe the failing pod. \`kubectl -n <ns> describe pod <pod>\`. Read the Events section at the bottom FIRST — that is where image pull errors, scheduling failures, and OOMKills are spelled out.
4. Container logs current. \`kubectl -n <ns> logs <pod> -c <container> --tail=200\`. Expected: app's startup output.
5. Container logs previous. \`kubectl -n <ns> logs <pod> -c <container> --previous --tail=200\`. This is the single most-forgotten flag. Use whenever RESTARTS > 0 or state is CrashLoopBackOff.
6. Exec in if the container stays up long enough. \`kubectl -n <ns> exec -it <pod> -c <container> -- sh\`. Inside: \`curl localhost:<port>/healthz\`, \`env | grep -v SECRET\`, \`cat /etc/resolv.conf\`.
7. If exec is impossible because the container crashes immediately, use an ephemeral debug container. \`kubectl -n <ns> debug <pod> -it --image=busybox --target=<container>\`.
8. Node state. \`kubectl describe node <node>\`. Look for MemoryPressure, DiskPressure, PIDPressure, NotReady conditions.
9. Service and endpoints. \`kubectl -n <ns> get svc,endpoints -l app=<name>\`. If endpoints is empty behind a Service, the selector label does not match the pod labels — the most common "why can't I reach my pod" cause.
10. NetworkPolicy. \`kubectl -n <ns> get networkpolicy\`. If present, verify the rules allow the traffic you are debugging.
11. Match the symptom to the frequent root causes table below.

## Frequent root causes
- \`ImagePullBackOff\` → wrong tag, wrong registry, missing pull secret. Fix: \`kubectl create secret docker-registry\` or correct the tag.
- \`CrashLoopBackOff\` exit 137 → OOMKilled. Fix: raise \`resources.limits.memory\`.
- \`CrashLoopBackOff\` exit 1 on startup → read \`--previous\` logs and fix the app.
- \`Pending\` forever → describe shows "0/N nodes available" + reason (insufficient CPU, taint mismatch, PVC binding).
- Running but not Ready → probe is wrong (wrong path, wrong port, unrealistic threshold) or the app never becomes healthy.
- Service with no endpoints → selector label mismatch.

## Output format
\`\`\`
## Symptom
<exact one-sentence description>

## Root cause
<mechanism in one paragraph>

## Evidence
$ kubectl describe pod <pod>
...
Events:
  ... OOMKilled

## Fix
\\\`\\\`\\\`yaml
resources:
  limits:
    memory: 512Mi
\\\`\\\`\\\`

## Verification
$ kubectl -n prod rollout status deploy/<name>
deployment "<name>" successfully rolled out
\`\`\`

## Anti-patterns
- Jumping to \`kubectl logs\` before \`kubectl describe\` — the Events block often answers it in 5 seconds.
- Forgetting \`--previous\` when RESTARTS > 0.
- Deleting a stuck pod "to see if it helps" — destroys the evidence.
- Editing a live deployment with \`kubectl edit\` during an incident — use \`kubectl rollout undo\` or a tracked change.
- Blaming networking without checking endpoints first.

## Depth signal
If after walking all six layers the root cause is still unclear, capture \`kubectl describe\` + logs + events and escalate to the platform team. Staring harder at the same output will not reveal new information.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 23. log-analysis
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.log-analysis",
    slug: "log-analysis",
    name: "Log analysis",
    description:
      "Extract signal from a large log dump. Clusters by error fingerprint, separates noise from new events, and produces a short ranked finding list.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "manual",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "shell_exec", "grep"],
    markdown: md`
---
name: log-analysis
description: Fingerprint and compare against a baseline, not single-snapshot grep
version: 2.0.0
trigger: manual
allowed_tools: [file_read, shell_exec, grep]
---

# Log analysis

A log file is not evidence until it is compared against a known-good
window. Single-snapshot analysis is how you end up chasing a warning
line that has been there for two years. This skill forces
fingerprinting and baseline comparison before any conclusion.

## When to use
- An incident is open and you need to find what changed in the logs.
- A new deploy went out and you suspect a regression.
- An alert fired on a noisy pattern and you need to separate signal from noise.
- A user reported an error and you need to find the matching server-side trace.
- A large log export needs triage before a meeting.

## When NOT to use
- You already know exactly which request failed and you have its trace id — just look it up.
- The log has structured fields indexed in a search tool — use that tool.
- The log is a single-line printf dump with no timestamps — different investigation.
- The "logs look fine" with no baseline comparison — that is not a valid conclusion.

## Process
1. Define the question in one sentence. "Is there a new error class since the last deploy?" and "Why did request X fail?" are different investigations with different filters.
2. Establish a baseline window. Pull the same length of logs from a period the system was healthy. Same service, same length, same log level.
3. Fingerprint errors. Strip variable parts so the same error with different ids collapses to one line.
   \`\`\`bash
   cat app.log \\
     | grep -i error \\
     | sed -E 's/[0-9a-f]{8,}/<id>/g; s/[0-9]+/<n>/g; s/"[^"]*"/<str>/g' \\
     | sort | uniq -c | sort -rn | head -20
   \`\`\`
   Expected output: ranked list of fingerprints with counts.
4. Fingerprint the baseline the same way. Save both to files.
5. Rank by: new in this window (absent from baseline), then delta vs baseline, then absolute volume.
   \`\`\`bash
   comm -23 <(sort today_fingerprints) <(sort baseline_fingerprints)
   \`\`\`
   Expected output: fingerprints present today but not in baseline.
6. A brand-new fingerprint at count 3 is more interesting than a familiar line at count 30,000. Do not be distracted by volume.
7. Correlate with deploy and incident timelines. If a new fingerprint appeared at T+2 min after a deploy, name the commit.
8. Pull one full example of each top fingerprint for context. Include request id, timestamp, and stack trace.
9. Produce the output below. Recommend exactly one next action per top finding.

## Output format
\`\`\`
## Question
<one sentence>

## Window
from <ts> to <ts> on <service> in <env>
baseline: <ts> to <ts>

## Top findings (ranked)
1. <fingerprint>
   Count: <N> (new since <time>)
   First seen: <ts>
   Example trace: <request id>
   Likely cause: <one-sentence hypothesis>
   Next action: <one concrete thing>

2. ...

## Recommended next action
<the single most valuable thing to do>
\`\`\`

## Anti-patterns
- "The logs look fine" with no baseline — you cannot tell from a snapshot.
- Grepping for one keyword and calling it done.
- Reporting raw counts without fingerprinting — the same error appears 50 ways.
- Correlating with "a deploy happened around that time" without naming the commit.
- Staring at raw logs in a terminal pager — fingerprint first.

## Depth signal
If the top 5 findings are all pre-existing with no delta, the problem is not in this log. Check upstream services, infra events, or a different log source.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 24. migration-planning
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.migration-planning",
    slug: "migration-planning",
    name: "Migration planning",
    description:
      "Plan a data, schema, or system migration with a reversible cutover strategy. Emphasizes dual-write, backfill, and a named rollback point.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "manual",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "search"],
    markdown: md`
---
name: migration-planning
description: Five-phase reversible migration: expand, dual-write, backfill, flip, contract
version: 2.0.0
trigger: manual
allowed_tools: [file_read, search]
---

# Migration planning

A migration that runs a script on Sunday night is not a plan, it is a
gamble. A plan is a sequence of independently reversible steps, each
boring enough to execute with a tired on-call watching the dashboards.
Skipping this skill ships migrations that cannot roll back.

## When to use
- Schema change to a table with production traffic.
- Moving data between databases or storage systems.
- Renaming a column, table, or service that has external consumers.
- Splitting one table into two, or merging two tables.
- Cutting over from one auth provider, queue, or cache to another.

## When NOT to use
- New table with no historical data — no migration needed, just add it.
- Internal rename with no external consumers and no data — one commit.
- Dev/staging environment that can be rebuilt from scratch.
- The workload has no production traffic yet — backfill is trivial.

## Process
1. Define the goal in one sentence naming old and new state. "Move user emails from \`users.email\` varchar(255) to \`user_contacts\` with FK and unique index."
2. Phase 1 — Expand. Add the new thing (column, table, service) alongside the old thing. Both exist. No traffic flows to the new one yet. Ship and verify.
3. Phase 2 — Dual-write. Every write path updates both old and new. Reads still go to old. Add a metric comparing old vs new so drift is visible. Ship and verify a full business cycle.
4. Phase 3 — Backfill. Copy historical data from old to new in batches. Checkpoint progress in a table so the backfill can resume after a restart. Verify with a full row count AND a sampled deep-compare on at least 1 percent of rows. Never trust a single query for data integrity.
5. Phase 4 — Flip reads. Switch reads to new behind a feature flag. Roll out per-tenant or per-percentage. Monitor a full business cycle — business cycles are not overnight, they are 7 days for most consumer products.
6. Phase 5 — Contract. Remove dual-writes, delete the old thing. Only after the monitoring window confirms stability.
7. Write the rollback plan for EACH phase. "Rollback: flip the flag back" counts. "We cannot roll back" is a blocker and must be fixed before executing.
8. Assign a cutover owner and a separate observer. Same person cannot drive and watch dashboards.
9. Announce to downstream consumers at least one business cycle before Phase 4.

## Required artifacts before any code ships
- Written rollback plan for each phase.
- Data integrity check that can be run at any time and confirms old = new.
- Named cutover owner and named observer (two people).
- Communication plan for downstream consumers.
- Dashboard for drift metric.

## Output format
\`\`\`markdown
# Migration: <goal sentence>

## Phases
### Phase 1 — Expand
Diff: <what we add>
Rollback: <how>
Ship gate: <metric to watch>

### Phase 2 — Dual-write
Diff: <which write paths>
Drift metric: <query or gauge>
Rollback: <how>

### Phase 3 — Backfill
Batch size: <N>
Checkpoint table: <name>
Resume strategy: <how>
Integrity check: <query or script>

### Phase 4 — Flip reads
Feature flag: <name>
Rollout: <tenants | percentages>
Monitoring window: <duration>

### Phase 5 — Contract
Diff: <what we remove>
Dependency on: <Phase 4 stability for N days>

## Cutover runbook (Phase 4)
- T-1d: <step>
- T-1h: <step>
- T-0:  <step>
- T+1h: <verify>
- T+1d: <verify>

## Owners
Cutover: @<name>
Observer: @<name>
\`\`\`

## Anti-patterns
- "Big bang" migration with no intermediate state — no rollback.
- Backfill with no resume-from-checkpoint — a crash kills progress.
- Deleting the old thing in the same PR that introduces the new — atomic break.
- Maintenance window over 90 minutes — the plan is wrong, redesign.
- Same person as cutover owner and observer — they cannot watch everything.
- Row count as the only integrity check — missing data-shape drift.

## Depth signal
If any single phase cannot be rolled back in under 10 minutes, stop and redesign. No production migration should require heroic recovery.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 25. performance-profiling
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.performance-profiling",
    slug: "performance-profiling",
    name: "Performance profiling",
    description:
      "Profile a slow endpoint or script and produce a ranked bottleneck report. Refuses to suggest fixes without measured before/after numbers.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "manual",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["shell_exec", "file_read", "grep"],
    markdown: md`
---
name: performance-profiling
description: Measure-first profiling, one change per iteration, numeric target
version: 2.0.0
trigger: manual
allowed_tools: [shell_exec, file_read, grep]
---

# Performance profiling

"I think this loop is slow" is an opinion. A profile is evidence. Most
failed optimizations come from skipping the measurement step: someone
rewrites a function that accounts for 2 percent of wall time and ships
nothing. This skill forces a target, a baseline, and one change at a
time.

## When to use
- An endpoint p95 regressed.
- User complains about slowness with a specific scenario.
- A script that used to run in 10s now runs in 90s.
- Before accepting a PR that claims "performance improvement".
- A dashboard shows CPU or memory climbing without an obvious workload change.

## When NOT to use
- There is no measurable symptom — you are optimizing preemptively.
- Dev environment only, no realistic data. Localhost with 100 rows is not a workload.
- The slow path runs once a year for an analyst — engineer time costs more.
- You do not have a reliable way to reproduce the slowness.

## Process
1. State the target. A target is a p95 latency number or a throughput number with a unit. "Cart API p95 under 200ms at 100 RPS" is a target. "Make it faster" is not.
2. Reproduce in a realistic environment. Prod is ideal, staging copy of prod data is acceptable, localhost with 100 rows is not.
3. Pick one layer. End-to-end HTTP, application CPU, database, or network. Profile one at a time. Mixing layers produces tangled flamegraphs.
4. Record the baseline. Exact command, exact version, exact data, exact number. Write it down before touching code. Run the command 3 times and record the median.
5. Run the profiler for the chosen layer:
   - HTTP load: \`hey -z 30s -c 50 http://<host>/api/...\` or \`wrk\` or \`k6\`. Expected output: p50, p95, p99, throughput.
   - Node CPU: \`0x\` or \`--prof\` + \`--prof-process\`. Expected output: flame graph.
   - Python CPU: \`py-spy record --pid <pid>\`. Expected output: speedscope file.
   - JVM CPU: \`async-profiler\`.
   - Postgres query: \`EXPLAIN (ANALYZE, BUFFERS)\`. Expected output: plan with actual timings.
6. Find the top three contributors. Ignore the long tail. If the top contributor is 5 percent of total time, the profile is uninteresting — fix elsewhere.
7. Form a hypothesis about the top contributor. One sentence.
8. Change one thing. Measure again. Record the delta vs baseline. If no improvement, revert and try another hypothesis.
9. Repeat until the target is hit or returns diminish below 10 percent per change.

## Output format
\`\`\`
## Target
<number with unit, e.g. "p95 < 200ms at 100 RPS">

## Baseline
Tool: <hey | wrk | py-spy | etc>
Command: <exact>
Data: <dataset name / row count>
Result: p50=<X>ms p95=<X>ms p99=<X>ms, throughput=<X>/s

## Top bottlenecks
1. <symbol / query / step> — <% of total> — hypothesis: <one sentence>
2. ...

## Change attempted
<file:line diff summary>

## After
Result: p50=<X>ms p95=<X>ms p99=<X>ms, throughput=<X>/s
Delta vs baseline: <+/- %>

## Decision
<accept | revert | continue to next hypothesis>
\`\`\`

## Anti-patterns
- Micro-benchmarking a function that accounts for 2 percent of total time.
- "I rewrote it in <language>, should be faster" without measurements.
- Adding a cache before confirming the path is CPU-bound, not I/O-bound — caches hide symptoms, not fix CPU.
- Running the profiler once and trusting the biggest bar — check variance across runs.
- Optimizing on dev data that does not match production shape.
- Fixing two things at once and attributing all improvement to one.

## Depth signal
If after five change attempts the target is still not hit, stop and question the target. Either the target was wrong, or the workload needs architectural change, not tuning.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 26. postmortem
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.postmortem",
    slug: "postmortem",
    name: "Incident postmortem",
    description:
      "Write a blameless postmortem that produces durable fixes, not blame. Enforces timeline, contributing factors, and trackable action items.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "manual",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "search"],
    markdown: md`
---
name: postmortem
description: Blameless postmortem that produces durable action items
version: 2.0.0
trigger: manual
allowed_tools: [file_read, search]
---

# Postmortem

A postmortem has one job: make the same class of incident less likely
or less severe next time. It is not a trial, not a performance review,
not a venue for grievances. A postmortem that names "human error" as
the root cause has failed — humans err, systems are supposed to
contain the blast radius.

## When to use
- Any S1 or S2 incident, regardless of cause.
- S3 incidents that revealed a new failure mode.
- Near-misses that would have been S1 if one more thing had failed.
- Repeat incidents where the same subsystem failed twice in a quarter.
- Launch failures where rollout paused or rolled back.

## When NOT to use
- Known-flaky tests — fix the test, no postmortem needed.
- Expected maintenance windows that went as planned.
- Vendor-side outages with no internal action items — a 2-line entry in the incident log is enough.
- Single-user bugs with no production impact.

## Process
1. Schedule within 72 hours of the incident close, while memory is fresh.
2. Pull the raw timeline from Slack, alert history, deploy logs, and incident channel transcript. Do not reconstruct from memory.
3. Draft the summary: two sentences naming what broke, who was affected, how long.
4. Fill the impact block with numbers: users affected (count or segment), duration of user impact (t_start to t_end), data loss (none or scope), revenue impact (number or "not measurable").
5. Write the timeline in UTC. Every entry is a fact with a source ("at 14:23 UTC, deploy pipeline ran D1234" not "around 2:30 someone said the service looked slow").
6. List contributing factors. There is no single root cause — real incidents have a chain. Name every link. Use system language, not personal language.
7. Write "what went well" and "what went wrong" sections. Never skip "what went well" — it is how you know which existing investments to protect.
8. Write action items. Every item needs: owner (one name), due date, ticket link, risk-reduction rating (high/med/low). No owner means it will not happen.
9. Rank action items by risk reduction, not by ease. Easy items come later if they do not move the needle.
10. Write the lessons section aimed at engineers six months from now who never heard of this incident.
11. Review with someone who was NOT on the incident call. Fresh eyes catch blame language the authors missed.

## Output format
\`\`\`markdown
# Postmortem: <incident title>
**Date:** <YYYY-MM-DD>  **Severity:** S1|S2|S3  **Authors:** <names>

## Summary
<two sentences: what broke, who was affected, how long>

## Impact
- Users affected: <number or segment>
- Duration of user impact: <t_start UTC> to <t_end UTC>
- Data loss: <none | scope>
- Revenue impact: <number or "not measurable">

## Timeline (UTC)
- T0    <factual event with source>
- T+2m  <event>
- T+5m  <action taken>
- T+23m <all-clear declared>

## Contributing factors
1. <system-level factor>
2. <system-level factor>
3. <system-level factor>

## What went well
- <thing, with source>

## What went wrong
- <thing, with source>

## Action items
| # | Action | Owner | Due | Ticket | Risk reduction |
|---|--------|-------|-----|--------|----------------|
| 1 | ...    | @name | ... | ...    | high           |

## Lessons
<short paragraph for the engineer six months from now>
\`\`\`

## Anti-patterns
- Action items of the form "be more careful".
- Root cause of "human error" — always name the system that allowed the error.
- Timelines reconstructed from memory without Slack or alert references.
- "Alice deployed without testing" instead of "the pipeline accepted a change with no tests".
- Publishing the doc without a review from someone not on the incident.
- Leaving "what went well" empty — that is how good investments get cut later.
- Action items with no owner or no due date — decoration.

## Depth signal
If two postmortems in the same quarter name the same contributing factor, stop writing action items and schedule a dedicated design review on that subsystem. Symptom patching is not working.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 27. prd-writing
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.prd-writing",
    slug: "prd-writing",
    name: "PRD writing",
    description:
      "Draft a product requirements doc that engineers actually want to read. Forces problem-first framing, non-goals, and measurable success criteria.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "manual",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read"],
    markdown: md`
---
name: prd-writing
description: Problem-first PRD with numeric success metrics and non-goals
version: 2.0.0
trigger: manual
allowed_tools: [file_read]
---

# PRD writing

A PRD is a contract between product and engineering about what is
being built and — more importantly — what is not. If a reader cannot
name the success metric and the non-goals after one minute of reading,
the PRD has failed. The risk of skipping this skill: scope creep in
every standup for the next six weeks.

## When to use
- A new feature is moving from idea to build.
- Two teams disagree on what "done" means for a shared initiative.
- Leadership has committed a launch date and engineering needs a spec.
- A user-visible behavior is changing and stakeholders need alignment.
- Before the design phase so engineers can challenge assumptions early.

## When NOT to use
- Internal refactor with no user-visible change — use a design doc.
- Bug fix with no new behavior.
- Research spike where the goal is to learn, not to build.
- The feature is already in design review — the time to write the PRD has passed.

## Process
1. Write the problem first. Who has the pain, how often, how bad. Link evidence (tickets, interviews, metrics). If there is no evidence, pause and ask for it — a PRD without evidence is a guess.
2. List goals. Each goal is a sentence describing the user outcome, not the feature. "Users can filter orders by status" is a feature. "Users can find their open orders in under 5 seconds" is a goal.
3. List non-goals. A PRD without non-goals gets reinterpreted on every standup. State what this project is not doing and why.
4. Describe users and use cases. Primary persona plus 3 concrete scenarios the feature must handle. Scenarios are specific: "Mina, a new user, lands on the dashboard at 9am Monday and needs to see yesterday's orders".
5. Write the proposal in two paragraphs max. High-level shape of the solution. Leave implementation detail to the design doc.
6. Write success metrics. Every metric must have a number, a target, and a time window. "80 percent of new users find their first order within 30 seconds in the first week" is a metric. "Users love it" is not.
7. Write guardrail metrics — things that must not regress. Existing p95 latency, conversion rate, error rate.
8. Write the rollout plan: feature flag name, phases (internal → beta → GA), rollback procedure.
9. List open questions with owners and needed-by dates.
10. Review with one engineer and one designer before marking it "approved". If either says "I do not know what to build", rewrite.

## Output format
\`\`\`markdown
# <Feature> PRD
**Author:** <name>  **Status:** draft | review | approved  **Last updated:** <YYYY-MM-DD>

## Problem
<who, what pain, how often, how bad. Evidence: <link>>

## Goals
- <user outcome, not feature>
- <user outcome>

## Non-goals
- <thing we are not doing and why>

## Users and use cases
Primary user: <persona>
Scenarios:
1. <specific>
2. <specific>
3. <specific>

## Proposal
<two paragraphs, high-level shape>

## Success metrics
- Primary: <metric + target + time window>
- Secondary: <metric + target + time window>

## Guardrails
- <metric that must not regress>

## Rollout
- Flag: <name>
- Phases: internal → beta cohort → GA
- Rollback: <how>

## Open questions
- <question> — owner: <name> — needed by: <date>

## Out of scope for this release
- <thing, tracked in <link>>
\`\`\`

## Anti-patterns
- Leading with the solution before the problem is stated.
- "TBD" left in success metrics at approval time.
- A PRD longer than 3 pages — you need a design doc, not a bigger PRD.
- Goals written as features ("add a button for X") instead of outcomes.
- Non-goals section missing entirely.
- Success metric "users love it" or "engagement increases" without a number.
- Missing guardrails — optimizing the primary metric by breaking a secondary.

## Depth signal
If the primary success metric still does not have a number after three drafts, stop and run user research. You are guessing at the target, and a guessed target makes a guessed product.
`,
  },

  // ───────────────────────────────────────────────────────────────────
  // 28. release-notes
  // ───────────────────────────────────────────────────────────────────
  {
    id: "builtin.release-notes",
    slug: "release-notes",
    name: "Release notes",
    description:
      "Write user-facing release notes from a changelog or commit list. Groups by user impact, not by component, and calls out breaking changes.",
    scope: "official",
    version: "2.0.0",
    enabled: true,
    trigger: "manual",
    source: "builtin",
    author: "YUA",
    iconUrl: null,
    installCount: 0,
    license: "YUA Built-in",
    allowedTools: ["file_read", "search"],
    markdown: md`
---
name: release-notes
description: User-facing release notes grouped by impact, breaking changes first
version: 2.0.0
trigger: manual
allowed_tools: [file_read, search]
---

# Release notes

Release notes are written for the person deciding whether to upgrade,
not for the person who wrote the code. That single reframing fixes
most bad release notes before they are written. "Various improvements
and bug fixes" is not release notes, it is laziness with formatting.

## When to use
- Shipping a new version of a library, CLI, SDK, or product to users.
- A deploy is going out that includes a user-visible change.
- The user says "write release notes", "changelog", "what changed".
- A breaking change lands on \`main\` and users need migration guidance.
- A security patch needs to be communicated with the right urgency.

## When NOT to use
- Internal-only release with no user-visible change — update the internal changelog, skip user notes.
- Zero-impact refactor, test, or chore commits — those do not earn an entry.
- Auto-generated version bumps from a dependency update.
- The user wants a commit history dump, not curated notes.

## Process
1. Pull the commit range. \`git log <prev-tag>..HEAD --oneline\`. Expected output: every commit since last release.
2. Read every commit and decide: does this affect users? If no, skip. Refactors, tests, internal docs, CI tweaks, chore bumps — skip.
3. Classify each kept commit into one of: Breaking, Added, Changed, Fixed, Deprecated, Removed, Security.
4. For each Breaking entry, write the migration in one sentence with a before/after code block. If you cannot write the migration, the change is not documented enough to ship yet.
5. Group the rest by user-visible area (API, CLI, UI), not by internal component (packages/foo-core, apps/bar-web).
6. Rewrite every entry in second-person present tense. "You can now filter by tag" not "Users can filter by tag" or "Added filter by tag feature".
7. Strip marketing adjectives. "Improved search speed" is fine. "Revolutionary new search experience" is not.
8. Put Breaking at the very top. Even if there is only one. Readers scan for breakage first.
9. For Security entries, include the CVE id if one was issued, the severity, and a one-line summary of what an attacker could have done.
10. Add an Upgrade notes section at the bottom listing the minimum steps to upgrade safely (e.g. "run \`pnpm install\`, then restart the server").
11. Date the release in ISO format. Release without a date is useless in a search.

## Output format
\`\`\`markdown
# <Product> <version> — <YYYY-MM-DD>

## Breaking changes
- <what broke> — to migrate:
  \\\`\\\`\\\`diff
  - old
  + new
  \\\`\\\`\\\`

## Added
- <user-visible capability in second person>

## Changed
- <non-breaking behavior change>

## Fixed
- <bug in user-visible terms, not internal id>

## Deprecated
- <thing> will be removed in <version>. Use <replacement>.

## Removed
- <previously deprecated thing>

## Security
- <CVE-YYYY-NNNNN> <severity> — <one-line summary>

## Upgrade notes
Minimum steps to upgrade safely:
1. <step>
2. <step>
\`\`\`

## Anti-patterns
- "Various improvements and bug fixes" as the entire entry.
- A Fixed item referencing an internal bug id with no description.
- Listing a change that only affects developers of the product itself under a user-facing heading.
- Writing in third person passive ("a new filter was added by the team").
- Hiding a breaking change inside the Changed section.
- Omitting the date — release notes without a date cannot be searched.
- Releasing a Security section with no CVE or severity and no summary.

## Depth signal
If the breaking changes section is longer than three entries, pause the release and schedule a migration guide document separate from the notes. A wall of breakages in a changelog will ship unread.
`,
  },
];
