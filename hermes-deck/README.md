# Hermes Deck (Electron)

Floating glass HUD for the Hermes desktop — a faithful port of
iris's "Deep Space" glass design system, driven by the existing
`~/.hermes/deck/display.json` feed. Chrome-free island layout:
no app header, no footer, no outer panel — every section is its own
free-floating `.hud-surface` island (iris hud.css), ~280px wide,
height hugs content.

## Layout

- `main.mjs` — Electron main: transparent frameless always-on-top window
  (`floating` level, 280px wide), vibrancy `hud`, single-instance lock,
  fs.watch + 1s poll of the atomic feed, 5s heartbeat consent-gate while
  visible, plus a path-validated `readFileTail` IPC (delegation
  transcripts only — no arbitrary fs access from the renderer).
- `preload.cjs` — contextBridge (`window.deck`): feed read/push, heartbeat
  age, visibility toggle, `readFileTail(path, maxLines)` (validated in the
  main process), `resolveLog(delegationId)`.
- `renderer/` — `tokens.css` (iris tokens, verbatim values), `deck.css`
  (free-floating HUD islands — one glass recipe from iris hud.css:
  `.hud-surface` fill/edge/inner-highlight, label-row drag strips,
  collapsible bodies, agent rows, log block), `deck.js` (feed render,
  island collapse state, accordion agent rows, 1s streaming-log poller),
  `index.html` (transparent shell only — islands are built by deck.js).
- Vendored runtime: Electron 42.5.0 with `LSUIElement=true` + bundle id
  patched (no Dock icon). Not included in this repo; see launcher notes.

## Interaction model

- Every section renders as its own glass island with a small-caps label
  row INSIDE it (iris "DELEGATED AGENTS" voice); that label row is the
  drag strip (`-webkit-app-region: drag`) and the collapse toggle.
- Collapsed sections render as small floating chip-islands (label +
  one-line mono summary). Collapse state is persisted in `localStorage`
  (`hermes-deck.collapsed.v1`).
- Default state: ONLY "Delegated agents" expanded; status / vitals /
  screen collapse to chips. The window is transparent and sized to hug
  the island stack, so islands read as floating directly on the desktop.
- A tiny mint heartbeat light (live/stale) sits at the right end of the
  agents island's label row — the consent-gate indicator.
- Clicking an agent row expands an inline detail view (accordion, one at
  a time): status chip, full detail text, started/relative timestamp, and
  a LIVE TRANSCRIPT block — the last ~60 lines of the delegation's
  `task-N.log`, monospace ~9px, auto-scrolled to the bottom, re-read
  every 1s while expanded. Collapsing the row stops the poller.

## Launch

- Installed app: `open -a "Hermes Deck"` (starts visible, floating islands)
- Hidden start: `open -a "Hermes Deck" --args --hidden`
- Debug: relaunch with `--remote-debugging-port=9222` (single-instance
  lock means the running instance must be quit first).

## Contracts

### Feed contract (read-only; writers are untouchable)

- Path: `~/.hermes/deck/display.json` — atomic JSON writes
  (tmp + rename) by `~/.hermes/scripts/deck_sync.sh` / `deck_push.sh`.
- Shape: `{ "updated": <epoch-seconds>, "cards": [ ... ] }`; card types
  `status`, `agents`, `vitals`, `screen`.
- `agents` items: `{ title, status: running|done|error, detail, ts }`.
  The deck resolves `deleg_[0-9a-f]+` from an item's title/detail to find
  its live transcript.

### Heartbeat contract (consent gate for screen capture)

- While the panel is visible, the main process touches
  `~/.hermes/deck/heartbeat` every 5s (renderer nudges too).
- `screen_sense.sh` refuses capture when heartbeat age > 15s.
- On quit, the heartbeat file is removed.

### Streaming transcripts (read-only)

- Path pattern:
  `~/.hermes/cache/delegation/live/<delegation_id>/task-N.log`
  (append-only text logs; `delegation_id` like `deleg_40f00b72`).
- The renderer never touches the fs directly: `readFileTail` IPC is
  validated in the main process (path must resolve inside the delegation
  live dir; basename must match `task-<digits>.log`; 20MB size cap;
  400-line tail cap).

## Security notes

- No secrets in the feed, the UI, or this repo. Renderer is sandboxed
  with `contextIsolation: true`, `nodeIntegration: false`; the only
  filesystem surface is the validated log-tail IPC.