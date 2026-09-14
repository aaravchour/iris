// Hermes Deck main — floating glass HUD over the desktop.
// Window + lifecycle patterns ported from iris's electron/main.mjs
// (single-instance lock, transparent frameless BrowserWindow, macOS levels).
import { app, BrowserWindow, ipcMain, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DECK_DIR = path.join(os.homedir(), ".hermes", "deck");
const FEED = path.join(DECK_DIR, "display.json");
const HEARTBEAT = path.join(DECK_DIR, "heartbeat");
const IS_MAC = process.platform === "darwin";

// Streaming transcripts live here — the ONLY fs area the renderer may read.
const DELEGATION_LIVE_DIR = path.join(
  os.homedir(), ".hermes", "cache", "delegation", "live"
);

// ---- Single instance (iris pattern) ---------------------------------------
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showWindow();
  });
}

const startHidden = process.argv.includes("--hidden");

// Dock icon off (LSUIElement behavior from main-process; the packed
// Info.plist also sets LSUIElement=true, this is the runtime belt+braces).
// NOTE: app.dock only exists after the ready event — hide it there.
app.whenReady().then(() => {
  try {
    app.dock?.hide();
  } catch {}
});

let win = null;
let feedWatcher = null;
let feedPollTimer = null;
let lastFeedMtime = 0;
let heartbeatTimer = null;
let quitting = false;

// The panel: compact 280-wide glass island, upper-right like the HUD rail.
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 280;
  const height = Math.min(480, workArea.height - 80);

  win = new BrowserWindow({
    width,
    height,
    minWidth: 240,
    minHeight: 120,
    x: Math.max(workArea.x + workArea.width - width - 18, workArea.x + 8),
    y: Math.max(workArea.y + 18, 0),
    show: !startHidden,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    backgroundColor: "#00000000",
    // Native macOS glass underlay (iris-style HUD). Falls back to CSS
    // backdrop-filter when unavailable (non-mac).
    ...(IS_MAC ? { vibrancy: "hud" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // HUD must keep rendering + heartbeat while occluded (iris pattern).
      backgroundThrottling: false,
    },
  });

  if (IS_MAC) {
    // Floating, not screen-saver level: stays over normal windows but yields
    // to real system overlays. (iris uses "screen-saver" only for its kiosk.)
    win.setAlwaysOnTop(true, "floating");
    // skipTransformProcessType is REQUIRED on macOS: without it this call
    // re-promotes the process to a regular (Dock-icon) app, undoing
    // LSUIElement / app.dock.hide(). (iris does the same for hideDock.)
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: false,
      skipTransformProcessType: true,
    });
  }

  // Renderer flags readiness once loaded; avoid focus steal: a HUD floats
  // over the desktop and must not activate the app (activation is what
  // re-registers the process as a Dock-icon "Foreground" app).
  win.once("ready-to-show", () => {
    if (!startHidden) {
      win.showInactive();
      // Belt+braces: showing can activate; re-assert LSUIElement behavior.
      try { app.dock?.hide(); } catch {}
    }
  });

  // Tell the renderer whether the native vibrancy underlay is active so it
  // can pick the right glass strategy (native blur vs CSS backdrop-filter).
  win.loadFile(path.join(__dirname, "renderer", "index.html"), {
    query: { vibrancy: IS_MAC ? "1" : "0" },
  });
  win.on("closed", () => {
    win = null;
  });
}

// ---- Feed watching: fs.watch + 1s poll fallback ---------------------------
function readFeed() {
  try {
    const raw = fs.readFileSync(FEED, "utf8");
    return JSON.parse(raw);
  } catch {
    return null; // half-written / missing: keep last good render
  }
}

function pushFeedToRenderer() {
  const data = readFeed();
  if (!data || typeof data !== "object") return;
  try {
    win?.webContents?.send("deck:feed", data);
  } catch {
    /* window gone */
  }
}

function startFeedWatch() {
  try {
    feedWatcher = fs.watch(DECK_DIR, (event, filename) => {
      if (filename && filename !== "display.json") return;
      // Writers are atomic (tmp + rename), small debounce for editor churn.
      clearTimeout(feedWatchDebounce);
      feedWatchDebounce = setTimeout(pushFeedToRenderer, 60);
    });
    feedWatcher.on("error", () => {
      /* dir watch failed → poll keeps us alive */
    });
  } catch {
    /* no dir yet → poll keeps us alive */
  }
  // Poll fallback every 1s: also re-pushes on mtime change in case fs.watch
  // silently misses events (network homes, APFS edge cases).
  feedPollTimer = setInterval(() => {
    try {
      const m = fs.statSync(FEED).mtimeMs;
      if (m !== lastFeedMtime) {
        lastFeedMtime = m;
        pushFeedToRenderer();
      }
    } catch {
      /* file missing → renderer keeps last data */
    }
  }, 1000);
}

let feedWatchDebounce = null;

// ---- Heartbeat consent gate ------------------------------------------------
// While the panel is open/visible, touch ~/.hermes/deck/heartbeat every ~5s.
// screen_sense.sh refuses capture when heartbeat age > 15s. Stop when hidden.
function touchHeartbeat() {
  try {
    fs.mkdirSync(DECK_DIR, { recursive: true });
    const now = new Date();
    // utimes-now touch (atomic-ish, no shell out)
    fs.closeSync(fs.openSync(HEARTBEAT, "w"));
    fs.utimesSync(HEARTBEAT, now, now);
  } catch {
    /* never let heartbeat failure kill the app */
  }
}

function heartbeatTick() {
  const visible = Boolean(win && !win.isDestroyed() && win.isVisible());
  if (visible) touchHeartbeat();
}

function startHeartbeat() {
  heartbeatTick(); // touch immediately on start
  heartbeatTimer = setInterval(heartbeatTick, 5000);
}

// ---- Safe transcript tail IPC ----------------------------------------------
// The renderer may ONLY read task logs under DELEGATION_LIVE_DIR. Everything
// is validated: normalized path must stay inside that directory, and the
// basename must look like task-<digits>.log. Returns { lines, path, found }.
function listTaskLogs(dirPath) {
  try {
    return fs
      .readdirSync(dirPath)
      .filter((f) => /^task-\d+\.log$/.test(f))
      .sort((a, b) => {
        const na = Number(a.match(/^task-(\d+)\.log$/)[1]);
        const nb = Number(b.match(/^task-(\d+)\.log$/)[1]);
        return na - nb;
      });
  } catch {
    return [];
  }
}

function tailLines(filePath, maxLines) {
  const cap = Math.min(Math.max(Number(maxLines) || 60, 1), 400);
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > 20 * 1024 * 1024) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    let lines = raw.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (lines.length > cap) lines = lines.slice(-cap);
    return lines;
  } catch {
    return null;
  }
}

ipcMain.handle("deck:read-log-tail", (_e, reqPath, maxLines) => {
  try {
    if (typeof reqPath !== "string" || reqPath.includes("\0")) {
      return { ok: false, error: "bad-path" };
    }
    const liveReal = fs.realpathSync(DELEGATION_LIVE_DIR);
    // Reject anything that even names a directory traversal segment.
    if (/(^|[\\/])\.\.($|[\\/])/.test(reqPath)) {
      return { ok: false, error: "bad-path" };
    }
    let candidate = path.isAbsolute(reqPath)
      ? reqPath
      : path.join(DELEGATION_LIVE_DIR, reqPath);
    if (!candidate.startsWith(DELEGATION_LIVE_DIR + path.sep)) {
      return { ok: false, error: "outside-live-dir" };
    }
    let real;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      return { ok: false, error: "not-found" };
    }
    if (real !== liveReal && !real.startsWith(liveReal + path.sep)) {
      return { ok: false, error: "outside-live-dir" };
    }
    const base = path.basename(real);
    if (!/^task-\d+\.log$/.test(base)) {
      return { ok: false, error: "bad-file" };
    }
    const lines = tailLines(real, maxLines);
    if (lines == null) return { ok: false, error: "unreadable" };
    return { ok: true, path: real, lines };
  } catch {
    return { ok: false, error: "unreadable" };
  }
});

// Resolve the newest task log for a delegation id (or a raw relative name).
ipcMain.handle("deck:resolve-log", (_e, rawId) => {
  try {
    if (typeof rawId !== "string" || rawId.includes("\0") || rawId.length > 256) {
      return { ok: false, error: "bad-id" };
    }
    let dirPath;
    if (/(^|[/\\])\.\.($|[/\\])/.test(rawId) || rawId.includes("/")) {
      // Full path form (still restricted to live dir, task-*.log only).
      let candidate = path.isAbsolute(rawId)
        ? rawId
        : path.join(DELEGATION_LIVE_DIR, rawId);
      if (!candidate.startsWith(DELEGATION_LIVE_DIR + path.sep)) {
        return { ok: false, error: "outside-live-dir" };
      }
      dirPath = path.dirname(candidate);
      const base = path.basename(candidate);
      if (/^task-\d+\.log$/.test(base)) {
        return { ok: true, path: candidate, name: base };
      }
      // Else fall through: treat dirname as the delegation dir.
    } else {
      dirPath = path.join(DELEGATION_LIVE_DIR, rawId);
    }
    const liveReal = fs.realpathSync(DELEGATION_LIVE_DIR);
    let dirReal;
    try {
      dirReal = fs.realpathSync(dirPath);
    } catch {
      return { ok: false, error: "not-found" };
    }
    if (dirReal !== liveReal && !dirReal.startsWith(liveReal + path.sep)) {
      return { ok: false, error: "outside-live-dir" };
    }
    const logs = listTaskLogs(dirReal);
    if (!logs.length) return { ok: false, error: "no-logs" };
    const name = logs[logs.length - 1];
    return { ok: true, path: path.join(dirReal, name), name };
  } catch {
    return { ok: false, error: "resolve-failed" };
  }
});

ipcMain.handle("deck:read-feed", () => readFeed());
ipcMain.handle("deck:heartbeat-age", () => {
  try {
    const m = fs.statSync(HEARTBEAT).mtimeMs;
    return Math.max(0, Date.now() - m);
  } catch {
    return null;
  }
});
ipcMain.on("deck:heartbeat", () => touchHeartbeat());
ipcMain.on("deck:toggle-visibility", () => {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else showWindow();
});

function showWindow() {
  if (!win) {
    createWindow();
    return;
  }
  // showInactive: never steal focus, never re-promote to a Dock app.
  win.showInactive();
  win.moveTop();
  try { app.dock?.hide(); } catch {}
}

// ---- Lifecycle ---------------------------------------------------------------
function onReady() {
  createWindow();
  startFeedWatch();
  startHeartbeat();

  // On hide/show re-evaluate consent immediately (heartbeatTick checks
  // visibility, so hiding stops touches within one tick).
  win?.on("hide", heartbeatTick);
  win?.on("show", heartbeatTick);
}

// whenReady may have multiple awaiting handlers (dock-hide above).
app.whenReady().then(onReady);

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  // Panel closed = HUD closed. Quit (LSUIElement app, nothing to keep alive).
  app.quit();
});

app.on("quit", () => {
  try {
    feedWatcher?.close();
  } catch {}
  if (feedPollTimer) clearInterval(feedPollTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  // On quit, remove the consent file (optional per contract).
  try {
    if (!startHidden) fs.rmSync(HEARTBEAT, { force: true });
  } catch {}
});