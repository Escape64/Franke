# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Stages 0–4 are done (stage 4 — collaboration depth — completed 2026-07-16: comments, @mentions, suggest mode, version history, all verified across two clients). Implemented so far: real-time collaborative editing (CodeMirror 6 + Yjs through a WebSocket relay, live cursors), disk persistence (vault at `~/FrankeVault`, plain `.md` files, CRDT sidecars in `.franke/`, a watcher merging external edits into the CRDT), E2E encryption + invite links (per-document AES-GCM key, a "blind" relay that only stores/forwards ciphertext blobs, `/d/<id>#<key>` guest links where the key never leaves the browser), the browser guest as a first-class flow (guest doc cached in IndexedDB, onboarding bar, "download .md" + stub "make your own copy" upsell), comments (selection-anchored threads that sync between clients), @mentions (autocomplete from participants, chips, unread-mention bell), suggest mode (propose-edit-to-selection with accept/reject), and version history (Yjs snapshots + slider modal, restore as a forward edit). There are no tests yet.

The product concept, UX flows, architecture, and implementation plan are documented (in Russian) in the user's Obsidian vault:

`/Users/artem/Yandex.Disk.localized/Obsidian Vault/01 Projects/Personal/Вайбкод/Franke/`

- `Концепция.md` — positioning, competitors, differentiation
- `UX и флоу.md` — roles and user flows
- `Техническая архитектура.md` — full technical design
- `План реализации.md` — staged implementation plan with "done when" criteria

Read those before proposing or building anything; keep them updated when decisions change.

## Commands

The repo lives at `/Users/artem/Documents/Franke` (moved off Yandex.Disk on 2026-07-15: cloud sync throttled builds and created conflicted copies like `default (2).json` that silently break Tauri builds — never develop inside a synced folder).

- `npm install` — install all workspaces (run from repo root)
- `npm run relay` — start the relay server on ws://localhost:1234
- `npm run dev` — start the Vite dev server on http://localhost:5173 (the web client)
- `cd app && npx tauri dev` — build and open the desktop (Tauri) window; expects the Vite dev server already running on 5173 (`beforeDevCommand` is intentionally empty)

`.claude/launch.json` defines `franke-relay` and `franke-app` preview configs for the Browser pane. The `tauri dev` watcher rebuilds on changes to existing `src-tauri/` files but does not notice newly added ones (e.g. a new `Info.plist`) — restart it manually in that case.

## What Franke is

A local-first markdown note-taking app (Obsidian-like) whose core feature is Google-Docs-style real-time collaboration without cloud storage: files stay on each participant's disk and sync peer-to-peer through a "blind" relay. Key differentiator: a recipient can edit a shared note live in a plain browser via an invite link, with nothing installed.

## Decided architecture (do not re-litigate without the user)

- **CRDT, not OT and not file sync.** Yjs is the chosen implementation; the CRDT document is the source of truth, the `.md` file on disk is a projection.
- **Networking:** a lightweight relay (WebSocket, store-and-forward) that only carries E2E-encrypted CRDT updates. The document key lives in the URL `#` fragment and never reaches the server. Pure P2P was rejected (requires simultaneous online). Optional `y-webrtc` LAN/P2P channel later.
- **Browser guest** is the same editor bundle served as a static site — not a separate product.
- **Access revocation** = document key rotation. Read-only access = separate read key from write key (read = the AES key; write = an ECDSA signature on every update, verified by all clients — the relay stays blind).

## Code map

- `relay/server.js` — custom relay on **yjs 13 + y-protocols**. Two room kinds: legacy plaintext y-protocol rooms (dev demo, dropped when empty) and **blind blob rooms at `/e/<docId>`** — a JSON-frame (`{type, blob}`) store-and-forward log the server can't read; these are NOT dropped on disconnect (the log must outlive an offline owner) and are in-memory only (don't survive a relay restart yet). Do NOT replace this relay with `@y/websocket-server`: that package is built against yjs 14 and silently fails to decode yjs-13 sync messages while awareness keeps working, which masks the breakage.
- `app/src/crypto.ts` + `app/src/encrypted-provider.ts` — E2E + permissions layer. `EncryptedRelayProvider` is a drop-in for `WebsocketProvider` over `/e/<docId>`: AES-GCM encrypts every update/awareness frame, queues edits made while offline, and re-sends full doc state after each `synced` (guarantees convergence; the log grows — delta protocol deferred). **Permissions (stage 5):** an update frame's plaintext is `sig(64B) || update`, signed with an ECDSA P-256 key; `ProviderKeys` carries `readKey`/`verifyKey`/`signKey`. Clients drop updates whose signature fails `verifyKey`; `signKey===null` is read-only (won't send). Awareness is never signed (presence/cursors are fine for readers). Share metadata (docId + AES key + `signPub`/`signPriv`) lives in `.franke/<rel>.share.json`, **never** in the `.md`. Invite fragment: `#<readKey>.<signPub>.<signPriv>` (write) or `#<readKey>.<signPub>` (read). Legacy stage-2 links (`#key` only) throw `legacy-link` — the signed frame format is incompatible, so the guest is told to ask for a new link; the owner's meta is auto-upgraded with an ECDSA pair on open. Revocation = `rotateShare` (new docId + all keys; reopening floods full state into the fresh room, old room goes stale). A note with no share meta runs fully offline (no provider); `NoteSession.provider` is null, `canWrite` true.
- Browser guest (`main.ts`, route `/d/<docId>#<key>`): `openEncryptedRoom` mounts `IndexeddbPersistence` (DB `franke-guest:<docId>`) and awaits `whenSynced` **before** attaching the network provider, so a reloaded/offline guest loads local state first. A loading overlay blocks typing until the first `synced` — otherwise the guest's insert at offset 0 concatenates with the owner's content arriving a beat later; after 4 s with no sync it flips to "owner offline, edits will send later" and unblocks. The guest gets an onboarding bar with a working "download .md" and a stub "make your own copy" upsell (no installer yet).
- Comments (`comments.ts` + `comments-editor.ts`): threads live in the same Y.Doc under a `comments` Y.Map (so they sync/merge like text and work offline). Anchors are `Y.RelativePosition` (encoded to Uint8Array) — recomputed to absolute offsets on every text change and comment-map change, so highlights don't drift when text before them is edited. `comments-editor.ts` is a CodeMirror extension: a `StateField<DecorationSet>` for the highlight marks (driven by the `setCommentRanges` effect), a floating "Comment" button over non-empty selections, and a click handler mapping a clicked mark back to its threadId. `main.ts` `mountComments` wires the Y.Map/`ytext` observers to a right-side threads panel and re-dispatches ranges. Works in all three modes (vault, guest, demo).
- Mentions (`mentions.ts`): names come from awareness + message authors. `@` in a comment/reply field opens an autocomplete (prefix-filtered, arrows/Enter/click). The autocomplete's Enter uses `stopImmediatePropagation` so it must be attached BEFORE the reply's own Enter-to-send handler, or Enter both picks and sends. Mentions render as chips (yellow `.me` when it's the current user, whose name can change live via the name input). Unread self-mentions (author ≠ me, not yet seen) drive a header bell; `seenMessages` tracks `${threadId}:${msgIndex}` keys, and opening a thread marks its messages seen.
- Suggestions / suggest mode (`suggestions.ts` + `suggestions-editor.ts`): "propose an edit to a selection", NOT live-typing track-changes. One `replace` model in a `suggestions` Y.Map — range `[start,end)` → `newText` (empty newText = deletion, empty range = insertion). Accept applies delete+insert to `ytext` and removes the suggestion; reject just removes it. The editor strikes the old range (`.cm-suggest-old`) and renders the proposed text as a green widget (`.cm-suggest-new`) after it. A second green "✏️ Предложить" button sits next to "Комментировать" in the selection actions widget.
- **Load-bearing gotcha (`safeDispatchEffects` in `main.ts`)**: the comment/suggestion decoration refresh runs from `ytext.observe` / `awareness` observers, which fire *inside* yCollab applying a remote change to CodeMirror. Calling `view.dispatch` synchronously there throws "Calls to EditorView.update are not allowed while an update is in progress", the plugin crashes, and the remote text edit silently fails to render (ytext is correct, the DOM is stale). All decoration dispatches from observers MUST go through `safeDispatchEffects`, which defers via `queueMicrotask`. Symptom if broken: accepting a suggestion updates the acceptor's text but not the other client's visible text.
- Version history (`versions.ts`): versions are Yjs snapshots (`Y.snapshot` — state vector + delete set, not a text copy) in a `versions` Y.Array of the same doc, so they sync to everyone. **All Y.Doc instances are created with `gc: false`** (collab.ts) — without it `createDocFromSnapshot` cannot reconstruct old states; the doc grows unboundedly (history compaction deferred). Checkpoints: on note open, manual, and before+after restore (deduped via `equalSnapshots`). Restore is a forward diff edit (origin `'restore'`), never a rewind — history stays intact.
- DOM-testing gotcha: `innerText` of `.cm-content` includes remote-cursor widget labels (user names) — compare against `.cm-line` textContent with zero-width chars stripped, or you'll see phantom "missing/extra text".
- `app/src/main.ts` — entry point and UI. Mode switch via `isTauri()`: in Tauri → vault mode (sidebar, file tree, notes); in a browser → a single room taken from `?room=`. Rooms are named `note:<encodeURIComponent(vault-relative-path)>`; the browser side re-encodes the path because `URLSearchParams` pre-decodes it.
- `app/src/vault.ts` — Tauri-only FS layer: vault at `~/FrankeVault`, sidecars at `.franke/<rel>.crdt`, recursive watcher (filters out `.franke/` and non-`.md` events). FS permissions come from `app/src-tauri/capabilities/default.json`; the `**` glob does **not** match dot-paths, so `.franke` has its own scope entries.
- `app/src/collab.ts` — `NoteSession` lifecycle. Seeding rules are load-bearing: with a sidecar → apply history, then diff the `.md` against it; without a sidecar → connect first, wait for sync (1.5 s cap), and seed only if the doc is still empty — blind seeding duplicates content when the room already has state. The initial state arrives before the `update` listener is attached, so `openNote` saves once immediately; otherwise nothing is persisted until the first edit. Saves are debounced (500 ms), write the sidecar always and the `.md` only when its text changed; `lastDiskText` distinguishes our own writes from external edits (watcher feedback-loop guard).
- `app/src-tauri/Info.plist` — disables macOS App Nap (`NSAppSleepDisabled`). Without it the OS suspends the backgrounded window and sync dies; keep it.

## Verification gotchas

- Two same-origin browser tabs sync through BroadcastChannel even when the relay is completely broken. Test relay changes with a Node ws client or the Tauri window, never with two tabs alone.
- The Tauri webview console is invisible from outside; window errors and FS failures are forwarded to `tauri dev` stdout via `@tauri-apps/plugin-log` (wired in `main.ts` and `vault.logFsError`). Check there first when the window "silently does nothing".

## Implementation order

Stage 5 (рост) is in progress: read-only access + revocation is done (see crypto/provider notes above), and the one-command self-hosted relay is done (`relay/Dockerfile` + `docker-compose.yml`; `docker compose up -d`; `/health` endpoint for the healthcheck; relay URL configurable in the client via `app/src/config.ts` — `?relay=` query param > localStorage > `VITE_RELAY_URL` build env > `ws://localhost:1234`; invite links carry `?relay=` so guests hit the owner's relay). Remaining per `План реализации.md`: folder sharing (folder structure as its own CRDT map), media blobs (images/PDF), mobile (Tauri 2). Also queued: relay log persistence/compaction, delta protocol instead of full-state-after-sync, real installer for the guest upsell button. Explicitly deprioritized until validation: graph view, whiteboard/canvas, plugins, own cloud storage, mobile feature parity.
