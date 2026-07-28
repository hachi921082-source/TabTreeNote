# HANDOFFv3.md — v3 post-M10c work handoff (supersedes HANDOFF.md for current v3 work)

> **Read this file FIRST for the current state of v3 work.** The top-level [HANDOFF.md](../../HANDOFF.md)
> is now stale for anything past "M10c complete" — it still describes the state as of 2026-07-25/26
> and does not know about the branch change to `v4`, the agent-type change (see below), or any of the
> post-M10c work (node-lock design amendments, Markdown decoration bug fixes) described here.
> HANDOFF.md's project overview / v1 (M0–M7) history / doc-structure sections are still accurate and
> not repeated here — read HANDOFF.md too for that background, just don't trust its "current status"
> or "next action" sections.

## Most important thing to know: the 4 named agents are gone

As of this session (2026-07-28/29), the `Agent` tool no longer offers `designer`/`developer`/`reviewer`/`tester`
as subagent types. They were replaced by **`designer-lite`/`developer-lite`/`reviewer-lite`**
(`reviewer-lite` covers what `reviewer`+`tester` used to split — static review AND actually running the
app to verify behavior, in one agent). This happened mid-session, apparently due to a user-side config
change (they said "専用Agentを変えたのを忘れていました" — "I forgot I had changed the dedicated agents").

**Differences to account for when using the lite agents on this project** (their own descriptions say
"don't use if the project already has the full 4-agent workflow" — but the full ones don't exist right
now, so this is what's available; compensate explicitly in your prompts each time):
- **They default to committing in small commits.** This project only commits on explicit user request
  (see HANDOFF.md "運用方針"). Always explicitly tell `developer-lite` **not to commit** — leave changes
  as uncommitted working-tree modifications.
- **They default to looking for `spec.md`/`DESIGN.md`.** This project's actual docs are named
  differently. Point them explicitly at the real files each time — see "Where to point lite agents"
  below.
- **No automatic dev→review chaining.** Unlike the old `developer` agent (which had `Agent` tool access
  and would self-dispatch to `reviewer`/`tester`), you (the orchestrator) must manually dispatch
  `developer-lite` → wait for its report → manually dispatch `reviewer-lite` → wait → decide next step.
  Don't assume one launches the other. (This was already a known failure mode with the old agents too —
  see HANDOFF.md's note about the M10c reviewer chain stalling mid-session; same risk applies here.)
- **Review-round cap policy still applies**: cap at ~2 review rounds before stopping to report to the
  user rather than auto-looping (established project policy, reconfirmed 2026-07-29: after 2 rounds
  where each round found a *different* blocking issue on the decoration-bug fix, work was explicitly
  paused and reported rather than continuing to a 3rd round). **User has since asked to reduce this
  further where possible — see "Token-conservation lesson" below.**
- `reviewer-lite` "re-derives current state from git each time rather than keeping a persistent log" —
  it does NOT read `AGENT_LOG.md` automatically the way old `reviewer`/`tester` did by convention; if you
  want it to know history, point it at specific docs/sections explicitly (as done in this session's
  prompts — see recent `AGENT_LOG.md` entries for the exact prompts used, they worked well).

### Where to point lite agents (priority order, per explicit user instruction 2026-07-29)
For any spec/design question on current post-M10c work, agents should check, in this order:
1. `docs/v3/milestones/M10c-markdown-toolbar-ui.md` (or whichever milestone doc is relevant)
2. `docs/post-M10-changes.md`
3. Only if still unanswered: `docs/v3/DESIGNv3.md` (relevant section) / whatever the agent's own
   default convention would point it to.

## Branch: work now happens on `v4`, not `v3`

User created a new branch `v4` from `v3`'s tip mid-session (2026-07-27) and said "これからの修正作業はv4でおこないます" (all future fix work happens on v4). `v4` currently = `v3`'s last commit (`49ee7e8`, "プロパティダイアログ") + one additional commit (`6539b0e`, `.gitignore` exclusions for some stray files — see HANDOFF.md's Git section, not important). **`v3` has nothing `v4` doesn't have** (verified via `git log v3..v4` / `git log v4..v3`). Just always double check `git branch --show-current` before committing anything — this session had one incident where a commit landed on the wrong branch because the user switched branches in the IDE concurrently without telling the orchestrator.

## Current uncommitted working-tree state (as of writing this file)

```
M AGENT_LOG.md
M docs/INDEX.md
M docs/v3/DESIGNv3.md
M src/main/index.ts
M src/renderer/App.css
M src/renderer/App.tsx
M src/renderer/components/Editor/MarkdownToolbar.tsx
M src/renderer/editor/decorationCommands.ts
M src/renderer/editor/markdownDecorations.ts
M src/shared/ipc-contract.ts
?? docs/post-M10-changes.md
?? src/renderer/editor/markdownSpanParser.ts
```

None of this is committed. Do not commit without explicit user instruction (as always for this project).
`docs/post-M10-changes.md` is the authoritative, living tracker for everything below — **read it in
full** before doing anything; this section is just a summary/pointer.

## What's done vs. in-progress vs. not-started (summary — `docs/post-M10-changes.md` has full detail)

### Done, implementation-complete, committed (before this session's post-M10c work started)
- v3 M8–M10c (node lock core/session-ops/boundary-move/tab-switch + Markdown format/live-preview/toolbar):
  fully implemented, reviewed, tested, **committed** (40 commits with role descriptions, on what's now
  `v4`). Not pushed to remote.
- Two portable zip builds made and left in `release/` (gitignored, not committed): `v3.zip` (built right
  after M10c tester passed) and `v3_1.zip` (rebuilt after some doc-only changes — **neither build
  contains the in-progress decoration-bug-fix code below**, both predate it).

### Design-confirmed, NOT yet implemented (on hold, no active work)
- **`docs/v3/DESIGNv3.md` §1.14** — new "permanently remove node lock" operation
  (`crypto:removeNodeLock`), mirroring `crypto:decryptMemoToPlain`'s re-auth discipline. Both the
  existing temporary-session unlock and this new permanent unlock stay as separate menu items
  (user-confirmed). Cost estimate: medium (~150-250 new lines in `nodeLock.ts` + 1 IPC channel + menu
  wiring, reusing lots of existing building blocks).
- **`docs/v3/DESIGNv3.md` §1.15** — block deletion of a still-🔒-locked (no-session) node from the tree
  context menu (currently possible without a password — found to be a stale/inaccurate code comment vs.
  actual behavior, not intentional). Multi-select: reject the *entire* batch if *any* selected item is
  locked, don't silently skip. New error code `NODE_LOCKED` recommended for a backend defense-in-depth
  check in `memo:delete`. Cost: small, additive on top of §1.14.
- **Lock-while-memo-is-open UX friction** — currently `handleRequestLockNode` hard-blocks locking a node
  if it (or a descendant) is open in the editor. Proposed fix (reuse the existing `handleLockMemo`
  pattern: `requestCloseCurrentMemo()` + explicit editor-state clear) was explained to the user and
  confirmed safe, but **not yet given final go-ahead to implement** — still just "proposed" status.

Neither §1.14/§1.15 nor the lock-while-open fix have been dispatched to any implementation agent yet.
User has not said to start these — wait for explicit instruction.

### Declined, not being pursued
- Standalone real Markdown syntax (headings via `#`, horizontal rule via `---`, bullet lists) — user
  explicitly said "いいえ、今回は見送ります" (no, skipping this for now) after a feasibility discussion.
  Don't bring it back up unless the user does.

### In progress — Markdown decoration bugs (the active work item)
Read `docs/post-M10-changes.md`'s "Markdown live preview decoration bugs (M10b)" section for full
detail; this is the dense part with 2 rounds of fix→review history already. Short version:

- **Bug B** (bold couldn't be turned off in preview mode) — **implemented and reviewer-lite-verified,
  done.**
- **Toolbar decoration buttons + native right-click menu removal** — **implemented and
  reviewer-lite-verified for single-span cases, done** (multi-span cases are blocked on Bug A below,
  since they share the same underlying command code).
- **Bug A** (stray `</span>` leaks as literal text) — **NOT done, in progress, currently paused.**
  - Round 1 fix (general overlap-safe segment split/merge in `decorationCommands.ts` +
    `markdownSpanParser.ts`) — implemented, but reviewer-lite round 1 found a regression: the
    segment-merge hygiene step didn't check textual contiguity, causing corruption on any
    multi-existing-span selection.
  - Round 2 fix (`last.to === seg.from` contiguity check) — implemented and confirmed correct in
    isolation, BUT reviewer-lite round 2 found the *original* requested repro (select text spanning
    multiple existing spans, then apply/clear a decoration) **still fails, as a silent total no-op**,
    due to a separate, deeper, pre-existing issue: `splitIntoSegments` (`decorationCommands.ts:103-143`)
    only handles selection boundaries landing on a span's *content* edge, not its *outer tag-markup*
    edge — and a normal mouse drag-selection across decorated spans in preview mode **always** lands on
    the outer edge (CodeMirror decoration widgets are atomic for position resolution), so this is not an
    edge case, it's the default/only way a real user would do this with the mouse.
  - **User decision (2026-07-29): pause here, do not auto-continue to round 3 — but user then asked
    "これ、直せそうなの？" (is this fixable?) and, after being told yes (well-understood, scoped gap in
    existing logic, same function already survived 2 rounds of similar fixes), asked about token cost
    and gave new instructions for how round 3 should proceed (see next section). So: round 3 IS
    approved to proceed, just with the new constraints below — check `docs/post-M10-changes.md` and/or
    recent `AGENT_LOG.md` tail for whether round 3 has actually been dispatched/completed yet by the
    time you're reading this, since that may have happened after this handoff file was written.**

## Explicit instructions for round 3 (and future rounds) of the decoration fix — user-mandated, 2026-07-29

1. **Token-conservation approach**: prefer `developer-lite`'s own pure-logic Node harness (the
   esbuild-bundled harness that imports the real `decorationCommands.ts`/`markdownSpanParser.ts` source
   with a fake minimal `EditorView`, no Electron needed — already used successfully in rounds 1 and 2) for
   exhaustive self-verification, INSTEAD of relying on `reviewer-lite`'s expensive full
   Electron+CDP runtime pass to catch each remaining gap one at a time. Explicitly instruct
   `developer-lite` to test the full boundary-condition state space itself (selection boundary on: span
   content edge / span outer tag edge / mid-raw-tag-text / plain-text-adjacent-to-span, in all
   combinations) using its own harness before reporting done, since the harness has proven capable of
   reproducing every bug found so far without needing Electron at all.
2. **Cap runtime verification to exactly ONE `reviewer-lite` round**, then report results to the user
   regardless of outcome (pass or fail) — do not auto-loop to a round 4 even if round 3's reviewer-lite
   pass finds something. This is a explicit reduction from the "~2 rounds" general project policy,
   specifically for this decoration-bug-fix sub-task, per the user's token-cost concern.
3. Still avoid native context-menu CDP synthetic clicks (hang risk) and OS-level
   `GetForegroundWindow`/`SetForegroundWindow`/window-focus APIs (privacy/disruption risk — an incident
   happened in reviewer-lite round 1 where an unrelated real desktop window's title got exposed and the
   test window got forced to the foreground; self-corrected, but avoid entirely going forward — CDP-only
   interaction, per the explicit instruction already given in round 2's dispatch prompt, which worked).
4. `--user-data-dir` still doesn't work for environment isolation (portable-mode app design) — use
   isolated-copy + positional-argument launch. `ELECTRON_RUN_AS_NODE=1` is set in the ambient shell env
   in this environment and silently makes `electron.exe` run as plain Node — must `env -u
   ELECTRON_RUN_AS_NODE` before every Electron launch (recurring gotcha every round so far).

## Other standing conventions (still valid, from the pre-existing HANDOFF.md / project memory)
- Environment isolation and no-native-context-menu-CDP-click rules above apply to ALL runtime testing on
  this project, not just decoration work.
- Auto memory files at `C:\Users\m9112\.claude\projects\c--Users-m9112-vscode2-TabTreeNote\memory\` are
  still relevant: `feedback_agent_delegation.md` (delegation/review-round policy),
  `project_tabtreenote_tester_isolation.md`, `project_tabtreenote_tester_context_menu_hang.md`.
- Don't proactively launch implementation agents without explicit user instruction — same policy as
  always, doubly true now that the agent landscape changed and mistakes are more likely.
