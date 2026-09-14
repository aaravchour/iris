/* Hermes Deck renderer — feed-driven re-render with CSS transitions.
   Free-floating island layout (iris hud.css): each section is its own
   .hud-surface island with a small-caps label row inside it; collapsed
   sections become small chip-islands. Agent rows expand into a detail
   view with a 1s-polled streaming transcript. Layout change only —
   glass styling comes straight from tokens.css (--hud-fill / --hud-edge /
   --hud-inner). */
"use strict";

const shellEl = document.getElementById("panel");

let lastSig = "";

/* ---------- heartbeat light lives in the agents island label row ---------- */
let hbEl = null;

function ensureHeartbeatEl() {
  if (hbEl) return;
  const row = shellEl.querySelector('.island-agents .island-label-row');
  if (!row) return;
  hbEl = document.createElement("span");
  hbEl.className = "hb";
  hbEl.innerHTML = `<span class="hb-dot"></span>`;
  hbEl.title = "heartbeat live";
  row.appendChild(hbEl);
}

/* ---------- collapsed-state persistence (localStorage) ---------- */
const LS_KEY = "hermes-deck.collapsed.v1";

function loadCollapsed() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}
let collapsedMap = loadCollapsed();
// Default state: ONLY the agents island expanded; everything else chips.
if (!Object.keys(collapsedMap).length) {
  collapsedMap = { agents: false, status: true, vitals: true, screen: true };
}
function saveCollapsed() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(collapsedMap));
  } catch {}
}
function isCollapsed(t) {
  return collapsedMap[t] === true;
}
function setCollapsed(t, v) {
  collapsedMap[t] = v;
  saveCollapsed();
}

/* ---------- helpers ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function relTime(ts) {
  if (ts == null) return "";
  const d = Math.max(0, (Date.now() / 1000 - Number(ts)));
  if (d < 5) return "just now";
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

function fmtTokens(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-US");
}

const DELEG_RE = /deleg_[0-9a-f]+/i;
function findDelegationId(...strs) {
  for (const s of strs) {
    if (typeof s !== "string") continue;
    const m = s.match(DELEG_RE);
    if (m) return m[0];
  }
  return null;
}

/* ---------- one-line summaries for collapsed chip-islands ---------- */
function agentsSummary(c) {
  const items = Array.isArray(c.items) ? c.items : [];
  if (!items.length) return "idle";
  const run = items.filter((it) => it.status === "running").length;
  const err = items.filter((it) => it.status === "error").length;
  const bits = [`${items.length} agent${items.length === 1 ? "" : "s"}`];
  if (run) bits.push(`${run} running`);
  if (err) bits.push(`${err} error`);
  return bits.join(" · ");
}
function vitalsSummary(c) {
  const gw = c.gateway_ms == null ? "gw —" : (c.gateway_ok === false ? `gw fail` : `gw ${c.gateway_ms}ms`);
  return `${gw} · ${esc(c.model || "—")}`;
}
function screenSummary(c) {
  const off = c.enabled === false;
  return off ? "off" : (c.captured_at ? relTime(c.captured_at) : "standby");
}

/* ---------- agents: one expandable row per item ---------- */
function agentRow(it, idx) {
  const status = ["running", "done", "error"].includes(it.status) ? it.status : "running";
  const id = findDelegationId(it.title, it.detail);
  const expanded = expandedId === id;
  return `<div class="agent-item ${expanded ? "expanded" : ""}" data-agent-id="${esc(id || "")}" data-idx="${idx}">
    <div class="agent-row" data-agent-id="${esc(id || "")}" data-idx="${idx}">
      <span class="chev">▸</span>
      <span class="dot ${status}" title="${esc(status)}"></span>
      <div class="agent-main">
        <div class="agent-title">${esc(it.title || "agent")}</div>
        <div class="agent-detail">${esc(it.detail || "")}</div>
      </div>
      <span class="agent-time">${esc(relTime(it.ts))}</span>
    </div>
    <div class="agent-detail-wrap">
      <div class="agent-detail-inner">
        <div class="agent-detail-top">
          <span class="chip chip-${esc(status)}">${esc(status)}</span>
          <span class="agent-started">started ${esc(relTime(it.ts))}</span>
        </div>
        <div class="agent-full-detail">${esc(it.detail || "no detail")}</div>
        ${id ? `<div class="log-block">
          <div class="log-head">live transcript · ${esc(id)}</div>
          <pre class="log-pre" id="log-pre-${idx}"></pre>
        </div>` : ""}
      </div>
    </div>
  </div>`;
}

/* ---------- collapsible island shell (label row = drag strip) ---------- */
function islandShell(t, title, bodyHtml) {
  const col = isCollapsed(t);
  const label = String(title || t).toUpperCase();
  return `<section class="hud-surface island-${esc(t)} ${col ? "collapsed" : ""}" data-type="${esc(t)}">
    <div class="island-label-row" data-card-toggle="${esc(t)}" role="button" aria-expanded="${col ? "false" : "true"}" tabindex="-1">
      <span class="chev">▸</span>
      <span class="island-label">${esc(label)}</span>
      <span class="island-mini" data-mini="${esc(t)}"></span>
    </div>
    <div class="island-body-wrap">
      <div class="island-body">${bodyHtml}</div>
    </div>
  </section>`;
}

/* ---------- island body renderers ---------- */
function agentsBody(c) {
  const items = Array.isArray(c.items) ? c.items : [];
  const rows = items.length
    ? items.map((it, i) => agentRow(it, i)).join("")
    : `<div class="empty-row">no delegated agents</div>`;
  return rows;
}

function vitalsBody(c) {
  const gwOk = c.gateway_ok === true;
  const gwClass = c.gateway_ms == null ? "warn" : gwOk ? "ok" : "warn";
  const gwVal = c.gateway_ms == null ? "unreachable" : `${c.gateway_ms}ms`;
  return `<div class="vitals-grid">
    <div class="vital"><div class="k">Gateway</div><div class="v ${gwClass}">${esc(gwVal)}</div></div>
    <div class="vital"><div class="k">Model</div><div class="v">${esc(c.model || "—")}</div></div>
    <div class="vital"><div class="k">Tokens</div><div class="v">${esc(fmtTokens(c.session_tokens))}</div></div>
    <div class="vital"><div class="k">Activity</div><div class="v">${esc(c.last_activity || "—")}</div></div>
  </div>`;
}

function statusBody(c) {
  return `<div class="status-chip">
    <span class="dot done"></span>
    <span class="t-title">${esc(c.title || "status")}</span>
    <span class="value">${esc(c.value || "")}</span>
  </div>`;
}

function screenBody(c) {
  const off = c.enabled === false;
  return `<div class="screen-row ${off ? "off" : ""}">
    <span class="eye">${off ? "🚫" : "👁"}</span>
    <div class="agent-main">
      <div class="agent-title">${esc(off ? "screen sense off" : (c.title || "screen sense"))}</div>
      ${c.note ? `<div class="note">${esc(c.note)}</div>` : ""}
    </div>
    <span class="agent-time">${c.captured_at ? esc(relTime(c.captured_at)) : ""}</span>
  </div>`;
}

function fallbackBody(c) {
  const t = c.type || "unknown";
  return `<div class="fallback-row">${esc(c.title || t)}${c.value ? " · " + esc(c.value) : ""}</div>`;
}

function renderCard(c) {
  const t = c.type || "unknown";
  if (t === "agents") {
    return islandShell(t, c.title || "delegated agents", agentsBody(c));
  }
  if (t === "vitals") {
    return islandShell(t, c.title || "vitals", vitalsBody(c));
  }
  if (t === "status") {
    return islandShell(t, c.title || "status", statusBody(c));
  }
  if (t === "screen") {
    return islandShell(t, c.title || "screen sense", screenBody(c));
  }
  return islandShell(t, c.title || t, fallbackBody(c));
}

/* ---------- streaming transcript ---------- */
const LOG_TAIL_LINES = 60;
const LOG_POLL_MS = 1000;
const LOG_DOM_CAP = 120;
let expandedId = null;
let logPollTimer = null;
let logSeq = 0;

function stopLogPoll() {
  if (logPollTimer) {
    clearInterval(logPollTimer);
    logPollTimer = null;
  }
}

function trimLogDom(pre) {
  while (pre.childNodes.length > LOG_DOM_CAP) {
    pre.removeChild(pre.firstChild);
  }
}

async function pollExpandedLog() {
  if (!expandedId) {
    stopLogPoll();
    return;
  }
  const itemEl = shellEl.querySelector(`.agent-item.expanded`);
  if (!itemEl) {
    stopLogPoll();
    return;
  }
  const idx = itemEl.getAttribute("data-idx");
  const pre = document.getElementById(`log-pre-${idx}`);
  if (!pre) return;
  const seq = ++logSeq;
  try {
    const res = await window.deck.resolveLog(expandedId);
    if (seq !== logSeq) return;
    if (!res || !res.ok || !res.path) {
      pre.textContent = `no live transcript for ${expandedId}`;
      pre.classList.add("log-missing");
      return;
    }
    const tail = await window.deck.readFileTail(res.path, LOG_TAIL_LINES);
    if (seq !== logSeq) return;
    if (!tail || !tail.ok || !Array.isArray(tail.lines) || !tail.lines.length) {
      pre.textContent = `no live transcript for ${expandedId}`;
      pre.classList.add("log-missing");
      return;
    }
    pre.classList.remove("log-missing");
    pre.textContent = "";
    for (const line of tail.lines) {
      const span = document.createElement("span");
      span.className = "log-line";
      span.textContent = line;
      pre.appendChild(span);
      pre.appendChild(document.createTextNode("\n"));
    }
    trimLogDom(pre);
    pre.scrollTop = pre.scrollHeight; // auto-scroll to bottom
  } catch {
    pre.textContent = `no live transcript for ${expandedId}`;
    pre.classList.add("log-missing");
  }
}

function startExpanded(itemEl) {
  const id = itemEl.getAttribute("data-agent-id");
  if (!id) return;
  if (expandedId === id) return;
  expandedId = id;
  stopLogPoll();
  pollExpandedLog();
  logPollTimer = setInterval(pollExpandedLog, LOG_POLL_MS);
}

function collapseExpanded() {
  if (expandedId == null) return;
  expandedId = null;
  stopLogPoll();
}

/* ---------- render loop ---------- */
function feedSig(data) {
  return JSON.stringify(data);
}

function miniFor(c) {
  const t = c.type || "unknown";
  if (t === "agents") return agentsSummary(c);
  if (t === "vitals") return vitalsSummary(c);
  if (t === "screen") return screenSummary(c);
  if (t === "status") return esc(c.value || "");
  return "";
}

function render(data) {
  if (!data || !Array.isArray(data.cards)) return;
  const sig = feedSig(data);
  if (sig === lastSig) return;           // no change → skip DOM churn
  lastSig = sig;
  shellEl.innerHTML = data.cards.map(renderCard).join("");
  // collapsed chips
  for (const c of data.cards) {
    const cardEl = shellEl.querySelector(`.hud-surface[data-type="${c.type || "unknown"}"]`);
    const mini = cardEl?.querySelector(".island-mini");
    if (mini) mini.innerHTML = miniFor(c);
  }
  ensureHeartbeatEl();
  // Reopen the previously-expanded agent row (re-render wipes the DOM).
  if (expandedId != null) {
    const el = shellEl.querySelector(`.agent-item[data-agent-id="${expandedId}"]`);
    if (el) {
      el.classList.add("expanded");
      pollExpandedLog();
    }
  }
  updateHeartbeat();
}

function updateHeartbeat() {
  fetchHeartbeat();
}

let hbPending = false;
async function fetchHeartbeat() {
  if (hbPending) return;
  hbPending = true;
  try {
    const res = await window.deck.getHeartbeatAge();
    const age = typeof res === "number" ? res : null;
    ensureHeartbeatEl();
    if (hbEl) {
      if (age != null && age < 15000) {
        hbEl.classList.remove("stale");
        hbEl.title = "heartbeat live";
      } else {
        hbEl.classList.add("stale");
        hbEl.title = "heartbeat stale";
      }
    }
  } catch {
    /* bridge unavailable */
  } finally {
    hbPending = false;
  }
}

/* ---------- wiring ---------- */
shellEl.addEventListener("click", (ev) => {
  // 1) island label row → collapse/expand whole island
  const labelRow = ev.target.closest(".island-label-row");
  if (labelRow && labelRow.dataset.cardToggle) {
    const t = labelRow.dataset.cardToggle;
    const islandEl = labelRow.closest(".hud-surface");
    const nowCollapsed = !islandEl.classList.contains("collapsed");
    islandEl.classList.toggle("collapsed", nowCollapsed);
    labelRow.setAttribute("aria-expanded", nowCollapsed ? "false" : "true");
    setCollapsed(t, nowCollapsed);
    return;
  }
  // 2) agent rows → accordion detail + streaming log
  const row = ev.target.closest(".agent-row");
  if (row) {
    const item = row.closest(".agent-item");
    if (!item) return;
    const id = item.getAttribute("data-agent-id");
    const wasExpanded = item.classList.contains("expanded");
    // accordion: close whichever row is open
    const open = shellEl.querySelector(".agent-item.expanded");
    if (open && open !== item) {
      open.classList.remove("expanded");
      open.querySelector(".agent-row")?.setAttribute("aria-expanded", "false");
    }
    if (wasExpanded) {
      item.classList.remove("expanded");
      item.querySelector(".agent-row")?.setAttribute("aria-expanded", "false");
      collapseExpanded();
    } else if (id) {
      item.classList.add("expanded");
      row.setAttribute("aria-expanded", "true");
      startExpanded(item);
    }
  }
});

window.deck.onFeed((data) => render(data));
window.deck.getFeed().then((d) => render(d));
setInterval(fetchHeartbeat, 5000);
fetchHeartbeat();

/* Renderer-side nudge: main also touches on its own 5s timer. */
setInterval(() => window.deck.touchHeartbeat(), 5000);

/* Vibrancy flag: native glass underlay vs CSS fallback. */
try {
  const q = new URLSearchParams(window.location.search);
  document.documentElement.classList.add(q.get("vibrancy") === "1" ? "vibrancy" : "no-vibrancy");
} catch {
  document.documentElement.classList.add("no-vibrancy");
}