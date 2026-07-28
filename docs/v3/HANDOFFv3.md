# HANDOFFv3.md — v3 post-M10c work handoff (supersedes HANDOFF.md for current v3 work)

> **Read this file FIRST for the current state of v3 work.** The top-level [HANDOFF.md](../../HANDOFF.md)
> is stale for anything past "M10c complete" — it does not know about the branch change to `v4`, the
> agent-type change (see below), or any of the post-M10c work described here. HANDOFF.md's project
> overview / v1 (M0–M7) history / doc-structure sections are still accurate and not repeated here — read
> HANDOFF.md too for that background, just don't trust its "current status"/"next action" sections.

## Most important thing to know: the 4 named agents are gone

As of 2026-07-28/29, the `Agent` tool no longer offers `designer`/`developer`/`reviewer`/`tester` as
subagent types. They were replaced by **`designer-lite`/`developer-lite`/`reviewer-lite`**
(`reviewer-lite` covers what `reviewer`+`tester` used to split — static review AND actually running the
app to verify behavior, in one agent). This was a user-side config change, confirmed intentional by the
user (not a bug to route around) — treat it as the permanent current state, not a temporary glitch.

**Differences to account for when using the lite agents on this project** (their own descriptions say
"don't use if the project already has the full 4-agent workflow" — but the full ones don't exist right
now, so this is what's available; compensate explicitly in your prompts every time):
- **They default to committing in small commits.** This project only commits on explicit user request.
  Always explicitly tell `developer-lite` **not to commit** — leave changes as uncommitted working-tree
  modifications, to be committed later via the separate `commit-with-role` agent (still available, not
  affected by this change) when the user asks.
- **They default to looking for `spec.md`/`DESIGN.md`.** This project's actual docs are named
  differently — see "Where to point lite agents" below, always point them explicitly.
- **No automatic dev→review chaining.** You (the orchestrator) must manually dispatch `developer-lite` →
  wait for its report → manually dispatch `reviewer-lite` → wait → decide next step. Don't assume one
  launches the other.
- **Review-round cap policy still applies** (established project policy): cap at ~2 rounds before
  stopping to report to the user rather than auto-looping, unless the user gives a different explicit cap
  for a specific task (e.g. "verify once and report regardless" was used successfully for the decoration
  fix's final round — see below).
- `reviewer-lite` re-derives current state from git each time rather than keeping a persistent log — it
  does NOT read `AGENT_LOG.md` automatically; point it at specific docs/sections explicitly if you want it
  to know history.
- **Token-conservation lesson learned this session**: for bugs that are really pure-logic issues (not
  DOM/UI-specific), have `developer-lite` build a standalone esbuild-bundled Node harness importing the
  real source modules with a fake minimal `EditorView`/`EditorState` (no Electron) and exhaustively
  self-verify there, rather than relying on `reviewer-lite`'s expensive full Electron+CDP runtime pass to
  iteratively discover remaining gaps one at a time. This worked very well for the decoration-command bug
  fixes (see below) — round 3's harness-heavy approach used ~112k tokens vs. ~255k/~163k for earlier
  rounds that leaned more on runtime discovery, and still passed final runtime verification cleanly.
- Runtime verification still needs real Electron+CDP when the bug is genuinely about DOM/rendering/click
  behavior — the harness approach isn't a replacement for that, just a way to avoid using it wastefully
  for bugs that don't actually need it.

### Where to point lite agents (priority order, per explicit user instruction 2026-07-29)
For any spec/design question on post-M10c work, agents should check, in this order:
1. The relevant milestone doc in `docs/v3/milestones/` if one exists for the feature area.
2. `docs/post-M10-changes.md` (the living tracker for all post-M10c bugs/design changes).
3. Only if still unanswered: `docs/v3/DESIGNv3.md` (relevant section — for node-lock work specifically,
   §1.14/§1.15 are the primary source since there's no dedicated milestone doc for those additions).

## Branch: work happens on `v4`, not `v3`

`v4` was branched from `v3`'s tip (2026-07-27); `v3` has nothing `v4` doesn't have. All work since then,
including everything below, is on `v4`. Always double-check `git branch --show-current` before
committing — this session had one incident where a commit landed on the wrong branch because the user
switched branches in the IDE concurrently without telling the orchestrator.

## Current state: working tree is clean, all prior work committed

As of 2026-07-29, `git status --short` on `v4` is clean. The Markdown decoration bug-fix work (see below)
was committed via `commit-with-role` (14 commits, role-described, not pushed to remote).

## What's done vs. not-started (full detail in `docs/post-M10-changes.md`)

### Done, implemented, verified, and committed
- v3 M8–M10c (node lock core/session-ops/boundary-move/tab-switch + Markdown format/live-preview/toolbar):
  fully implemented, reviewed, tested, committed (40 commits, on what's now `v4`).
- **Markdown live-preview decoration bug fixes — fully done as of 2026-07-29, committed**:
  - Bug A (stray `</span>` leaking as literal text) — fixed across 3 rounds (overlap-safe segment
    split/merge → contiguity check for the merge step → outer-tag-edge boundary handling), final
    real-Electron runtime verification passed including a genuine CDP-simulated mouse-drag selection
    across multiple decorated spans (the actual real-world trigger). Full blow-by-blow history in
    `docs/post-M10-changes.md` — worth reading if a similar span/segment bug ever resurfaces, the 3 root
    causes found were all subtle and distinct.
  - Bug B (bold couldn't be turned off in preview mode) — fixed (widget self-reports its source range via
    `data-decoration-from/-to`, resolved via `EditorView.domEventHandlers({mousedown})` instead of
    unreliable browser DOM Selection through the opaque widget).
  - New toolbar decoration buttons (bold/color/font-size) added to `MarkdownToolbar`, native OS
    right-click decoration submenu removed from `src/main/index.ts` (redundant now).
  - New shared module `src/renderer/editor/markdownSpanParser.ts` (`findSpans`) — both
    `decorationCommands.ts` and `markdownDecorations.ts` now agree on exactly what counts as an existing
    span; useful reference if touching either file again.
- Two portable zip builds in `release/` (gitignored, not committed): `v3.zip`, `v3_1.zip` — **both predate
  the decoration-bug-fix commits above**, so if the user wants a build reflecting current code, rebuild
  first (`npx electron-vite build && npx electron-builder --win zip --publish=never`, then rename the
  output in `release/`).

### Design-confirmed, NOT yet implemented — ready-to-dispatch instructions below
- **`docs/v3/DESIGNv3.md` §1.14** — new "permanently remove node lock" operation.
- **`docs/v3/DESIGNv3.md` §1.15** — block deletion of a still-🔒-locked (no-session) node.
- **Lock-while-memo-is-open UX friction** (`docs/post-M10-changes.md`, same-named section) — currently
  `handleRequestLockNode` hard-blocks locking if the target/a descendant is open in the editor; proposed
  fix reuses the existing `handleLockMemo` pattern. Explained to and accepted by the user as safe.

**As of 2026-07-29, the user has asked for prepared dispatch instructions for both of the above (§1.14+§1.15
as one task, the UX friction fix as a separate task) to be written out here, WITHOUT actually launching
any agent yet** — they intend to have these done, just not necessarily immediately in this session. If you
are a future session picking this up: check with the user whether they still want these done before
dispatching (don't assume the presence of prepared instructions here means go-ahead — it doesn't, unless
the user explicitly says so in the current conversation).

### Declined, not being pursued
- Standalone real Markdown syntax (headings via `#`, horizontal rule via `---`, bullet lists) — user
  explicitly declined ("いいえ、今回は見送ります") after a feasibility discussion. Don't bring it back up
  unless the user does.

---

## Prepared instruction: §1.14 + §1.15 node-lock implementation (developer-lite)

Copy this as the `Agent` tool prompt (`subagent_type: "developer-lite"`) when the user gives the go-ahead:

```
Repository: c:\Users\m9112\vscode2\TabTreeNote (TabTreeNote, Electron + TypeScript).

Reference priority for spec questions: `docs/v3/DESIGNv3.md` §1.14 and §1.15 are the primary source for
this task (no dedicated milestone doc exists for these two additions — they were added directly to
DESIGNv3.md via a design-reconsideration request, not a new milestone). `docs/post-M10-changes.md`'s
"Node lock (v3 M8 feature) refinements" section has a condensed summary with file/line pointers if you
want a faster orientation before reading the full DESIGNv3.md sections. Do NOT commit — working-tree
changes only, per this project's convention.

## Task 1 — §1.14: new "permanently remove node lock" operation

Currently, once a node is locked (via `crypto:lockNode`, `src/main/crypto/nodeLock.ts`), there is no way
to permanently strip the lock and restore the subtree to fully normal, unencrypted, freely-movable status
— only toggling locked/unlocked-session or full deletion. Implement the new escape hatch per DESIGNv3.md
§1.14's confirmed design:
- New IPC `crypto:removeNodeLock(tabId, memoName, password, lockContext?)` → `Result<void>`, mirroring
  `lockNode`'s flow in reverse: derive key from the lock's stored salt/KDF params, decrypt
  `blobCiphertextB64` to get `NodeLockBlob` (same as `unlockNode` does), then for the origin + every
  descendant member, decrypt its individual `.txtenc` content, write it back as a plain `.txt`/`.md` file
  using its *original* real name (from `nameMap`/`formatMap`), delete the obfuscated `.txtenc`, and splice
  the restored `MetaTreeNode` structure back into the normal meta tree in place of the `lock`-bearing
  placeholder. New file writes/deletes go through the same `selfWriteRegistry`/`atomicWrite`/retry
  conventions as `lockNode` already uses (see `docs/00-core-principles.md` if you need a refresher on
  those cross-cutting conventions — not v3-specific, but still authoritative).
- Nested (still-locked) descendants: do NOT force-decrypt them — promote them as-is (still
  `lock`-bearing, opaque) into the restored structure. Only the directly-targeted lock is removed.
- New error code `NAME_DUPLICATE` for the case where a restored name collides with something already
  present in the destination scope — use the same all-or-nothing pre-check pattern as `moveIntoSession`
  (check all names for collisions before writing anything, reject the whole operation if any collide,
  don't partially restore).
- No session-key reuse: always require a fresh password entry for this operation (same discipline as
  `crypto:decryptMemoToPlain`), even if an unlock session is currently active for this node — don't wire
  this to skip re-authentication just because a session happens to be open.
- UI: new context-menu item alongside the existing "ロックを解除" (which stays, unchanged) — something
  like "ロックを完全に解除する" — with an irreversible-action confirmation dialog before the password
  prompt (this is a security-relevant, unrecoverable action; follow this app's existing `ConfirmDialog`
  conventions, check how similar irreversible actions are confirmed elsewhere, e.g. deletion).

## Task 2 — §1.15: block deletion of a still-locked (no-session) node

Currently `src/renderer/components/Tree/Tree.tsx` (~L386–396 as of the last time this was read — verify
current line numbers) always shows a "削除" item on a locked (no-session) node's context menu alongside
"ロックを解除", letting anyone delete a password-protected subtree without ever proving they know the
password (a stale/inaccurate code comment nearby claims single-select shows only "ロックを解除" — the
actual code doesn't match that comment; not intentional, needs fixing as part of this task too). Per
DESIGNv3.md §1.15:
- Remove the delete option from a locked node's context menu — deletion of a locked subtree should
  require going through one of the two unlock paths first (temporary session, or the new permanent
  removal from Task 1).
- Multi-select: if the current selection contains ANY still-locked node (not just the right-clicked row —
  check the full `selection.selected` set, this is also a pre-existing correctness gap per §1.15's notes),
  reject the ENTIRE batch delete, don't silently skip just the locked member(s).
- Backend defense-in-depth: add a check in `memo:delete`'s non-`lockContext` branch
  (`src/main/ipc/memoHandlers.ts`) rejecting deletion of a `lock`-bearing node, with new error code
  `NODE_LOCKED` (distinct from the existing move/copy-specific `LOCK_BOUNDARY_VIOLATION`).

## Verification
This is mostly backend/IPC logic plus tree-menu UI logic, not a pure-rendering bug like the decoration
work — full confidence likely needs some real Electron runtime testing (this app's actual crypto/file I/O
flows), but do as much as you reasonably can statically/via typecheck first. Run `npm run typecheck` and
`npx electron-vite build`, fix any errors. If you have a way to reasonably unit-test the crypto
round-trip (lock → removeNodeLock → verify restored plaintext/filenames match original) without a full
Electron app, that's valuable — but don't force it if it's not natural for this code shape; runtime
verification will be done next by `reviewer-lite` regardless.

Report back: what you implemented, any design questions that came up (escalate to `designer-lite` if you
hit a real one, pointing it at the same docs above), and what you verified vs. left for the runtime pass.
```

**After `developer-lite` reports back**: dispatch `reviewer-lite` for runtime verification (same
environment-isolation / no-native-context-menu / no-OS-focus-API constraints as always — see "Other
standing conventions" below). Given this touches security-relevant deletion/decryption logic, don't
skip the runtime pass or cap it as aggressively as the decoration fix's final round was capped — this
warrants at least one full, unhurried verification round. Ask it to specifically test: permanent-unlock
round-trip (lock a subtree with mixed plain/`.md` members and a nested lock inside it, remove the lock,
confirm all non-nested members are correctly restored with original names/content/format and the nested
lock survives untouched), the new confirmation dialog's irreversibility framing, and that a locked node's
context menu genuinely has no delete option in both single- and multi-select (including the "hidden
locked node inside a mixed multi-select" correctness-gap case).

---

## Prepared instruction: lock-while-memo-is-open UX fix (developer-lite)

Copy this as the `Agent` tool prompt (`subagent_type: "developer-lite"`) when the user gives the
go-ahead:

```
Repository: c:\Users\m9112\vscode2\TabTreeNote (TabTreeNote, Electron + TypeScript).

Reference: `docs/post-M10-changes.md`, section "Lock-while-memo-is-open UX friction" — read it in full
for complete context (it already has the proposed fix approach, confirmed safe, just needs
implementing). Do NOT commit — working-tree changes only.

Currently, `handleRequestLockNode` (`src/renderer/App.tsx`, search for that function name) fully blocks
the "サブツリーをロック" action with a status message telling the user to manually close the memo first,
if the target node or any descendant is currently open in the editor. Replace this hard block with an
automatic close: reuse the exact pattern already used by the existing M6 "ロック" button
(`handleLockMemo`, same file, search for it) when locking a currently-open encrypted memo — call
`requestCloseCurrentMemo()` (handles unsaved-edit confirmation/auto-save for you) and, once it resolves
true (not cancelled), explicitly clear editor state (`setOpenMemo(null)`, `setContentLF('')`,
`setDirty(false)`, and whatever else `handleLockMemo` clears — copy its exact set) before proceeding to
show the lock dialog. If `requestCloseCurrentMemo()` returns false (user cancelled an unsaved-changes
prompt), abort the lock action the same way `handleLockMemo` does.

This needs to work correctly whether the open memo is the target node itself, or a descendant of it (the
current check uses `treeNodeContains` — keep using that to decide whether to trigger the close).

Run `npm run typecheck` and `npx electron-vite build`. Report back what changed and how confident you are
it correctly handles: target-node-is-open, descendant-is-open, unsaved-changes-then-cancel (lock should
not proceed), unsaved-changes-then-confirm/auto-save (lock should proceed after save completes).
```

**After `developer-lite` reports back**: dispatch `reviewer-lite` for a real runtime check (small task,
one round should suffice) — locking the currently-open memo (plain and dirty), locking a node whose
descendant is open and dirty, and confirming cancel-on-unsaved-prompt correctly aborts the lock.

---

## Other standing conventions (still valid)
- Environment isolation: `--user-data-dir` doesn't work (portable-mode app) — use isolated-copy +
  positional-argument launch for any Electron runtime testing.
- Never use native context-menu CDP synthetic clicks (hang risk — real prior incident) or OS-level
  `GetForegroundWindow`/`SetForegroundWindow`/window-focus APIs (privacy/disruption risk — also a real
  prior incident, twice now across different sessions) — CDP-only interaction
  (`Runtime.evaluate`/`Input.dispatch*`) for all runtime testing on this project.
- `ELECTRON_RUN_AS_NODE=1` is set in the ambient shell env in this environment and silently makes
  `electron.exe` run as plain Node — always `env -u ELECTRON_RUN_AS_NODE` before launching Electron.
- Auto memory files at `C:\Users\m9112\.claude\projects\c--Users-m9112-vscode2-TabTreeNote\memory\`:
  `feedback_agent_delegation.md`, `project_tabtreenote_tester_isolation.md`,
  `project_tabtreenote_tester_context_menu_hang.md` — still relevant.
- Don't proactively launch implementation agents without explicit user instruction. The two prepared
  instructions above are ready-to-use text, not standing authorization to run them.
