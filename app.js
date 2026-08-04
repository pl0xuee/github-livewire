/* livewire — a telemetry board for GitHub's public event stream.
 *
 * The Events API is a poll well, not a socket: GitHub hands over up to 100
 * events per request and names its own cadence in X-Poll-Interval. Polling on
 * that cadence and dumping each batch would make the page lurch once a minute,
 * so arrivals go through a buffer that releases them one at a time, paced to
 * drain just before the next poll lands. The wire streams; the API doesn't.
 *
 * Conditional requests (If-None-Match) that come back 304 are free against
 * the rate limit, so idle watching of a quiet target costs nothing.
 */

"use strict";

const API = "https://api.github.com";
const WIRE_CAP = 120;       // rows kept in the DOM
const BUFFER_CAP = 400;     // events waiting to be released
const SEEN_CAP = 4000;      // ids remembered for dedup

/* ── channels ──────────────────────────────────────────────────────────
 * Fixed identities, fixed colours (see style.css for the validation note).
 * Every colour is always beside its name in text — never colour alone. */

const CHANNELS = [
  { key: "push",    name: "push",    glyph: "↑" },
  { key: "star",    name: "star",    glyph: "★" },
  { key: "fork",    name: "fork",    glyph: "⑂" },
  { key: "release", name: "release", glyph: "◆" },
  { key: "pr",      name: "pull",    glyph: "⇄" },
  { key: "issue",   name: "issue",   glyph: "◉" },
  { key: "create",  name: "create",  glyph: "+" },
  { key: "delete",  name: "delete",  glyph: "×" },
  { key: "other",   name: "other",   glyph: "·" },
];

const TYPE_TO_CHANNEL = {
  PushEvent: "push",
  WatchEvent: "star",
  ForkEvent: "fork",
  ReleaseEvent: "release",
  PullRequestEvent: "pr",
  PullRequestReviewEvent: "pr",
  PullRequestReviewCommentEvent: "pr",
  IssuesEvent: "issue",
  IssueCommentEvent: "issue",
  CreateEvent: "create",
  PublicEvent: "create",
  DeleteEvent: "delete",
};

/* ── state ─────────────────────────────────────────────────────────── */

const MAX_TARGETS = 10;

const state = {
  raw: localStorage.getItem("lw-target") || "",
  token: localStorage.getItem("lw-token") || "",
  muted: new Set(JSON.parse(localStorage.getItem("lw-muted") || "[]")),
  targets: [],          // { path, label, etag, pollMs, timer, at, dead }
  limitUntil: 0,        // epoch ms the account-wide rate limit lifts
  paused: false,
  buffer: [],
  seen: new Set(),
  counts: Object.fromEntries(CHANNELS.map(c => [c.key, 0])),
  total: 0,
  releasedAt: [],       // arrival timestamps for the per-minute rate
  repoTally: new Map(),
  actorTally: new Map(),
  firstBatch: true,
  trickleTimer: null,
};

const $ = id => document.getElementById(id);
const els = {
  wire: $("wire"), wireEmpty: $("wireEmpty"), ledger: $("ledger"),
  hotRepos: $("hotRepos"), hotActors: $("hotActors"),
  totalCount: $("totalCount"), rateCount: $("rateCount"),
  statuschip: $("statuschip"), statusword: $("statusword"),
  pollReadout: $("pollReadout"), limitReadout: $("limitReadout"),
  watchSummary: $("watchSummary"), watchBox: $("watchBox"),
  targetInput: $("targetInput"), tokenInput: $("tokenInput"),
  pauseBtn: $("pauseBtn"), scope: $("scope"),
  ghBtn: $("ghBtn"), revReadout: $("revReadout"),
  updateChip: $("updateChip"), updateWord: $("updateWord"),
  updateDialog: $("updateDialog"), updateSummary: $("updateSummary"),
  updateSubjects: $("updateSubjects"), updateNow: $("updateNow"),
  updateLater: $("updateLater"),
  ghStatus: $("ghStatus"), ghStatusWord: $("ghStatusWord"),
  statusDialog: $("statusDialog"), statusOverall: $("statusOverall"),
  statusComponents: $("statusComponents"), statusIncidents: $("statusIncidents"),
  statusClose: $("statusClose"),
};

/* Running inside the Tauri shell? Then links open in the system browser and
 * the updater can actually run; in a plain browser both fall away. */
const IS_APP = !!window.__TAURI__;
const BUILT_COMMIT =
  typeof window.__LW_COMMIT === "string" && /^[0-9a-f]{40}$/.test(window.__LW_COMMIT)
    ? window.__LW_COMMIT
    : null;

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ── target parsing ────────────────────────────────────────────────── */

/* The watch box takes a list — "torvalds mozilla/firefox org:nasa" —
 * separated by spaces or commas. Empty means idle: no polling at all. */
function parseTargets(raw) {
  const paths = new Set();
  const out = [];
  for (const word of raw.trim().split(/[,\s]+/)) {
    if (!word) continue;
    const t = word.replace(/^github\.com\//, "").replace(/^@/, "");
    let target;
    const follows = t.match(/^(?:feed|follows):(.+)$/);
    if (t === "global") target = { path: "/events", label: "the firehose" };
    else if (follows) {
      // received_events is the feed of everyone this user follows — the
      // whole circle in a single poll target.
      target = { path: `/users/${follows[1]}/received_events`, label: `${follows[1]}'s circle` };
    }
    else if (t.startsWith("org:")) target = { path: `/orgs/${t.slice(4)}/events`, label: `org ${t.slice(4)}` };
    else if (t.includes("/")) target = { path: `/repos/${t}/events`, label: t };
    else target = { path: `/users/${t}/events`, label: `@${t}` };
    if (paths.has(target.path)) continue;
    paths.add(target.path);
    out.push({ ...target, etag: null, pollMs: 60000, timer: null, at: 0, dead: false });
  }
  return out.slice(0, MAX_TARGETS);
}

const liveTargets = () => state.targets.filter(t => !t.dead);

/* Every API request goes through here, and only here attaches the token —
 * structurally, the token cannot travel anywhere but api.github.com. It is
 * also never acquired by the app on its own: it exists only after the user
 * pastes one or presses "use gh" on their own machine (the hosted web page
 * has no gh access at all). */
function apiFetch(path, headers = {}) {
  const h = { Accept: "application/vnd.github+json", ...headers };
  if (state.token) h.Authorization = `Bearer ${state.token}`;
  return fetch(`${API}${path}`, { headers: h });
}

/* ── polling — one independent loop per target ─────────────────────── */

async function pollTarget(t) {
  clearTimeout(t.timer);

  // The rate limit is account-wide, so one 403 grounds every loop.
  if (state.limitUntil > Date.now()) {
    scheduleTarget(t, state.limitUntil - Date.now() + 1000);
    return;
  }

  let res;
  try {
    res = await apiFetch(`${t.path}?per_page=100`, t.etag ? { "If-None-Match": t.etag } : {});
  } catch {
    setStatus("error", "offline");
    scheduleTarget(t, 30000);
    return;
  }

  readRateLimit(res);

  if (res.status === 304) {
    steadyStatus();
    scheduleTarget(t, intervalFor(t));
    return;
  }

  if (res.status === 401) {
    setStatus("error", "bad token");
    scheduleTarget(t, 120000);
    return;
  }

  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    const wait = Math.max(30000, (reset || Date.now() + 60000) - Date.now() + 2000);
    state.limitUntil = Date.now() + wait;
    setStatus("limit", "rate-limited");
    showEmptyError(`rate limit reached — resuming ${new Date(state.limitUntil).toLocaleTimeString()}`,
      "add a token below to raise the ceiling");
    // Stagger the wake-ups so the whole watch list doesn't burst the
    // moment the limit lifts.
    scheduleTarget(t, wait + Math.max(0, state.targets.indexOf(t)) * 2000);
    return;
  }

  if (res.status === 404) {
    t.dead = true;
    setStatus("error", `${t.label} not found`);
    updateWatchSummary();
    if (liveTargets().length === 0) {
      showEmptyError("nothing found to watch", "check the handles — user · owner/repo · org:name");
    }
    return;
  }

  if (!res.ok) {
    setStatus("error", `http ${res.status}`);
    scheduleTarget(t, 60000);
    return;
  }

  t.etag = res.headers.get("etag");
  t.pollMs = Math.max(10, Number(res.headers.get("x-poll-interval") || 0)) * 1000;

  let events;
  try { events = await res.json(); } catch { events = []; }

  // Schedule before ingesting so the trickle paces itself against the real
  // window until the next poll, not a stale timestamp.
  scheduleTarget(t, intervalFor(t));
  if (Array.isArray(events)) ingest(events);

  steadyStatus();
}

/* The request budget — 60/hour anonymous, 5,000/hour with a token — is
 * shared by the whole account, so it's split across however many targets
 * are being watched (with headroom kept for avatars and the update check).
 * 304s are free, but there's no knowing in advance which polls will 304. */
function intervalFor(t) {
  const n = Math.max(1, liveTargets().length);
  const floor = state.token
    ? Math.max(10, Math.ceil((n * 3600) / 4500))
    : 60 * n;
  return Math.max(t.pollMs, floor * 1000);
}

function scheduleTarget(t, ms) {
  // A target removed while its fetch was in flight must not reschedule
  // itself — that would leave an orphan polling forever off the books.
  if (!state.targets.includes(t)) return;
  t.at = Date.now() + ms;
  clearTimeout(t.timer);
  t.timer = setTimeout(() => pollTarget(t), ms);
}

function nextPollAt() {
  const upcoming = liveTargets().map(t => t.at).filter(at => at > Date.now());
  return upcoming.length ? Math.min(...upcoming) : 0;
}

function steadyStatus() {
  setStatus(state.paused ? "paused" : "live", state.paused ? "paused" : "live");
}

function readRateLimit(res) {
  const remaining = res.headers.get("x-ratelimit-remaining");
  const limit = res.headers.get("x-ratelimit-limit");
  if (remaining !== null && limit !== null) {
    els.limitReadout.textContent = `api ${remaining}/${limit}`;
  }
}

/* ── intake: dedup, buffer, trickle ────────────────────────────────── */

function ingest(events) {
  // API returns newest first; the buffer releases oldest first.
  const fresh = [];
  for (const ev of events) {
    if (state.seen.has(ev.id)) continue;
    state.seen.add(ev.id);
    fresh.push(ev);
  }
  if (state.seen.size > SEEN_CAP) {
    const trim = [...state.seen].slice(0, state.seen.size - SEEN_CAP);
    for (const id of trim) state.seen.delete(id);
  }

  fresh.reverse();
  state.buffer.push(...fresh);
  if (state.buffer.length > BUFFER_CAP) state.buffer.splice(0, state.buffer.length - BUFFER_CAP);

  runTrickle();
}

function runTrickle() {
  if (state.trickleTimer || state.paused || state.buffer.length === 0) return;

  // Pace the queue to drain shortly before the next poll; the opening batch
  // pours faster so the board fills while the room is still being warmed up.
  const runway = Math.max(2000, nextPollAt() - Date.now() - 3000);
  let gap = Math.min(2500, Math.max(120, runway / state.buffer.length));
  if (state.firstBatch) gap = 60;
  if (reducedMotion) gap = Math.min(gap, 200);

  state.trickleTimer = setTimeout(() => {
    state.trickleTimer = null;
    const ev = state.buffer.shift();
    if (ev) release(ev);
    if (state.buffer.length === 0) state.firstBatch = false;
    runTrickle();
  }, gap);
}

function release(ev) {
  const channel = TYPE_TO_CHANNEL[ev.type] || "other";

  state.counts[channel]++;
  state.total++;
  state.releasedAt.push(Date.now());
  tallyUp(state.repoTally, ev.repo?.name);
  tallyUp(state.actorTally, ev.actor?.login);

  scopePulse(channel);

  if (!state.muted.has(channel)) {
    els.wireEmpty.hidden = true;
    els.wire.prepend(renderEvent(ev, channel));
    while (els.wire.children.length > WIRE_CAP) els.wire.lastChild.remove();
  }

  renderLedger();
  renderBoards();
  renderTotals();
}

function tallyUp(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

/* ── narration: event → verb + detail ──────────────────────────────── */

function firstLine(s, max = 90) {
  if (!s) return "";
  const line = String(s).split("\n")[0].trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function narrate(ev) {
  const p = ev.payload || {};
  switch (ev.type) {
    case "PushEvent": {
      // The global firehose trims push payloads to ref/head/before; the
      // per-user and per-repo feeds still carry the commit list.
      const branch = (p.ref || "").replace(/^refs\/(heads|tags)\//, "");
      const n = p.size ?? p.commits?.length;
      const head = p.commits?.[p.commits.length - 1];
      if (head != null || n != null) {
        return {
          verb: `pushed ${n} commit${n === 1 ? "" : "s"} to`,
          detail: head ? { sha: head.sha?.slice(0, 7), text: firstLine(head.message) } : null,
        };
      }
      return {
        verb: branch ? `pushed ${branch} on` : "pushed to",
        detail: p.head ? { sha: p.head.slice(0, 7) } : null,
      };
    }
    case "WatchEvent": return { verb: "starred" };
    case "ForkEvent": return { verb: "forked", detail: p.forkee ? { text: `→ ${p.forkee.full_name}` } : null };
    case "ReleaseEvent": return {
      verb: `published ${p.release?.tag_name || "a release"} of`,
      detail: p.release?.name ? { text: firstLine(p.release.name) } : null,
    };
    case "CreateEvent":
      if (p.ref_type === "repository") return { verb: "created repository" };
      return { verb: `created ${p.ref_type || "ref"} ${p.ref || ""} in` };
    case "DeleteEvent": return { verb: `deleted ${p.ref_type || "ref"} ${p.ref || ""} from` };
    case "PullRequestEvent": {
      const merged = p.action === "closed" && p.pull_request?.merged;
      return {
        verb: `${merged ? "merged" : p.action || "touched"} PR #${p.number ?? p.pull_request?.number ?? "?"} on`,
        detail: p.pull_request?.title ? { text: firstLine(p.pull_request.title) } : null,
      };
    }
    case "PullRequestReviewEvent": return {
      verb: `reviewed PR #${p.pull_request?.number ?? "?"} on`,
      detail: p.pull_request?.title ? { text: firstLine(p.pull_request.title) } : null,
    };
    case "PullRequestReviewCommentEvent": return {
      verb: `commented on PR #${p.pull_request?.number ?? "?"} in`,
      detail: p.comment?.body ? { text: firstLine(p.comment.body) } : null,
    };
    case "IssuesEvent": return {
      verb: `${p.action || "touched"} issue #${p.issue?.number ?? "?"} on`,
      detail: p.issue?.title ? { text: firstLine(p.issue.title) } : null,
    };
    case "IssueCommentEvent": return {
      verb: `commented on #${p.issue?.number ?? "?"} in`,
      detail: p.comment?.body ? { text: firstLine(p.comment.body) } : null,
    };
    case "CommitCommentEvent": return { verb: "commented on a commit in" };
    case "GollumEvent": return { verb: "edited the wiki of" };
    case "MemberEvent": return { verb: `added ${p.member?.login || "someone"} to` };
    case "PublicEvent": return { verb: "open-sourced" };
    case "SponsorshipEvent": return { verb: "sponsored" };
    default: return { verb: ev.type.replace(/Event$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() + " on" };
  }
}

/* ── rendering ─────────────────────────────────────────────────────── */

function renderEvent(ev, channel) {
  const meta = CHANNELS.find(c => c.key === channel);
  const { verb, detail } = narrate(ev);
  const repo = ev.repo?.name || "";
  const actor = ev.actor?.login || "";

  const li = document.createElement("li");
  li.className = "ev";
  li.style.setProperty("--c", `var(--${channel})`);
  li.style.setProperty("--cf", `var(--${channel}-fill)`);

  const rail = document.createElement("span");
  rail.className = "ev-rail";

  const glyph = document.createElement("span");
  glyph.className = "ev-glyph";
  glyph.textContent = meta.glyph;
  glyph.title = meta.name;

  const face = document.createElement("img");
  face.className = "ev-face";
  face.alt = "";
  face.loading = "lazy";
  if (ev.actor?.avatar_url) face.src = `${ev.actor.avatar_url}${ev.actor.avatar_url.includes("?") ? "&" : "?"}s=40`;

  const line1 = document.createElement("div");
  line1.className = "ev-line1";
  const actorA = document.createElement("a");
  actorA.className = "ev-actor";
  actorA.href = `https://github.com/${actor}`;
  actorA.target = "_blank";
  actorA.rel = "noopener";
  actorA.textContent = actor;
  const verbSpan = document.createElement("span");
  verbSpan.textContent = ` ${verb} `;
  const repoA = document.createElement("a");
  repoA.className = "ev-repo";
  repoA.href = `https://github.com/${repo}`;
  repoA.target = "_blank";
  repoA.rel = "noopener";
  repoA.textContent = repo;
  line1.append(actorA, verbSpan, repoA);

  const line2 = document.createElement("div");
  line2.className = "ev-line2";
  if (detail) {
    if (detail.sha) {
      const sha = document.createElement("span");
      sha.className = "ev-sha";
      sha.textContent = detail.sha + " ";
      line2.append(sha);
    }
    line2.append(document.createTextNode(detail.text || ""));
  }

  const time = document.createElement("time");
  time.className = "ev-time";
  const at = new Date(ev.created_at);
  time.dateTime = ev.created_at;
  time.textContent = at.toLocaleTimeString([], { hour12: false });

  li.append(rail, glyph, face, line1, line2, time);
  return li;
}

function renderLedger() {
  const max = Math.max(1, ...Object.values(state.counts));
  for (const c of CHANNELS) {
    const btn = els.ledger.querySelector(`[data-channel="${c.key}"]`);
    btn.querySelector(".channel-count").textContent = state.counts[c.key];
    btn.querySelector(".channel-meter i").style.setProperty("--w", `${(state.counts[c.key] / max) * 100}%`);
  }
}

function buildLedger() {
  els.ledger.replaceChildren();
  for (const c of CHANNELS) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "channel";
    btn.type = "button";
    btn.dataset.channel = c.key;
    btn.setAttribute("aria-pressed", String(!state.muted.has(c.key)));
    btn.title = `Mute ${c.name} events on the wire`;
    btn.style.setProperty("--c", `var(--${c.key})`);
    btn.style.setProperty("--cf", `var(--${c.key}-fill)`);
    btn.innerHTML = `<span class="channel-glyph" aria-hidden="true">${c.glyph}</span>
      <span class="channel-name">${c.name}</span>
      <span class="channel-count">0</span>
      <span class="channel-meter"><i></i></span>`;
    btn.addEventListener("click", () => {
      if (state.muted.has(c.key)) state.muted.delete(c.key);
      else state.muted.add(c.key);
      btn.setAttribute("aria-pressed", String(!state.muted.has(c.key)));
      localStorage.setItem("lw-muted", JSON.stringify([...state.muted]));
    });
    li.append(btn);
    els.ledger.append(li);
  }
}

function renderBoards() {
  // Bots aren't watchable users, so they get no quick-add button.
  const unlessBot = name => (name.endsWith("[bot]") ? null : name);
  renderBoard(els.hotRepos, state.repoTally, 7, { meter: true, tokenFor: name => name });
  renderBoard(els.hotActors, state.actorTally, 5, { meter: false, tokenFor: unlessBot });
}

function renderBoard(root, tally, n, opts) {
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  root.replaceChildren();
  if (top.length === 0) {
    const li = document.createElement("li");
    li.className = "board-empty";
    li.textContent = "waiting for traffic";
    root.append(li);
    return;
  }
  const watched = new Set(getTokens().map(t => t.toLowerCase()));
  const max = top[0][1];
  for (const [name, count] of top) {
    const li = document.createElement("li");
    li.className = "boardrow";
    const a = document.createElement("a");
    a.className = "boardrow-name";
    a.href = `https://github.com/${name}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = name;
    const c = document.createElement("span");
    c.className = "boardrow-count";
    c.textContent = count;
    li.append(a, c);
    const token = opts.tokenFor(name);
    if (token && !watched.has(token.toLowerCase())) {
      const add = document.createElement("button");
      add.className = "boardrow-add";
      add.type = "button";
      add.textContent = "+";
      add.title = `watch ${token}`;
      add.addEventListener("click", () => addWatch(token));
      li.append(add);
    }
    if (opts.meter) {
      const meter = document.createElement("span");
      meter.className = "boardrow-meter";
      const fill = document.createElement("i");
      fill.style.setProperty("--w", `${(count / max) * 100}%`);
      meter.append(fill);
      li.append(meter);
    }
    root.append(li);
  }
}

function renderTotals() {
  els.totalCount.textContent = state.total;
  const cutoff = Date.now() - 60000;
  state.releasedAt = state.releasedAt.filter(t => t >= cutoff);
  els.rateCount.textContent = state.releasedAt.length;
  document.title = `${state.total ? state.total + " · " : ""}livewire — github telemetry`;
}

/* ── status & readouts ─────────────────────────────────────────────── */

function setStatus(kind, word) {
  els.statuschip.dataset.state = kind;
  els.statusword.textContent = word;
}

function showEmptyError(msg, sub) {
  if (els.wire.children.length > 0) return;
  els.wireEmpty.hidden = false;
  els.wireEmpty.classList.add("is-error");
  els.wireEmpty.children[0].textContent = msg;
  els.wireEmpty.children[1].textContent = sub || "";
}

setInterval(() => {
  const at = nextPollAt();
  if (at) {
    const s = Math.max(0, Math.round((at - Date.now()) / 1000));
    els.pollReadout.textContent = `next poll ${s}s`;
  } else {
    els.pollReadout.textContent = "polling off";
  }
  renderTotals();
}, 1000);

function updateWatchSummary() {
  const live = liveTargets();
  els.watchSummary.textContent = live.length
    ? `watching ${live.map(t => t.label).join(" · ")}`
    : "off the air";
}

/* ── the seismograph ───────────────────────────────────────────────── */

const scope = (() => {
  const canvas = els.scope;
  const ctx = canvas.getContext("2d");
  let w = 0, h = 0, dpr = 1;
  const samples = [];        // pen positions, newest last
  const ticks = [];          // { x, channel } event markers, in sample-space
  let impulses = [];         // decaying kicks to the pen
  const css = getComputedStyle(document.documentElement);
  const colorOf = ch => css.getPropertyValue(`--${ch}`).trim() || "#7d8890";
  const filament = css.getPropertyValue("--filament").trim();

  function size() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    dpr = devicePixelRatio || 1;
    w = rect.width; h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function pulse(channel) {
    impulses.push({ a: 0.55 + Math.min(0.4, impulses.length * 0.1), decay: 0.82 });
    ticks.push({ x: samples.length, channel });
  }

  function step() {
    // pen = baseline + summed impulses, with a whisper of noise so the
    // line reads as alive even when the wire is quiet
    let kick = 0;
    impulses = impulses.filter(i => (kick += i.a, (i.a *= i.decay) > 0.02));
    const noise = (Math.sin(samples.length * 0.7) + Math.sin(samples.length * 1.9)) * 0.012;
    const y = h * 0.62 - kick * h * 0.42 - noise * h;
    samples.push(y);
    const overflow = samples.length - Math.ceil(w / 2);
    if (overflow > 0) {
      samples.splice(0, overflow);
      for (const t of ticks) t.x -= overflow;
      while (ticks.length && ticks[0].x < 0) ticks.shift();
    }
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    // event ticks along the floor, each in its channel colour
    for (const t of ticks) {
      ctx.fillStyle = colorOf(t.channel);
      ctx.fillRect(t.x * 2, h - 6, 2, 4);
    }
    // the trace
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const x = i * 2;
      i === 0 ? ctx.moveTo(x, samples[i]) : ctx.lineTo(x, samples[i]);
    }
    ctx.strokeStyle = filament;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  let raf = null;
  function loop() {
    // Nothing to draw while the canvas is hidden (narrow layouts) — but
    // keep looping so the trace resumes when a resize brings it back.
    if (w > 0) {
      step();
      draw();
    }
    raf = requestAnimationFrame(loop);
  }

  function start() {
    size();
    if (reducedMotion) {
      // no scrolling trace — just redraw accumulated ticks on demand
      draw();
      return;
    }
    if (!raf) raf = requestAnimationFrame(loop);
  }

  addEventListener("resize", () => { size(); if (reducedMotion) draw(); });

  return {
    start,
    pulse(channel) {
      if (w === 0) return;
      if (reducedMotion) {
        ticks.push({ x: ticks.length % Math.ceil(w / 2), channel });
        draw();
        return;
      }
      pulse(channel);
    },
  };
})();

function scopePulse(channel) { scope.pulse(channel); }

/* ── controls ──────────────────────────────────────────────────────── */

/* The watch list is a set of tokens ("torvalds", "rust-lang/rust",
 * "org:nasa", "global") shown as chips. Changing it is incremental: targets
 * already on the air keep their ETags and timers, the wire is never wiped
 * just because one station was added or dropped. */

function getTokens() {
  return state.raw.trim() ? state.raw.trim().split(/[,\s]+/).filter(Boolean) : [];
}

function setTokens(tokens) {
  const seen = new Set();
  const clean = [];
  for (const t of tokens) {
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); clean.push(t); }
  }
  state.raw = clean.join(" ");
  localStorage.setItem("lw-target", state.raw);
  applyWatch();
}

function addWatch(token) { setTokens([...getTokens(), token]); }
function removeWatch(token) { setTokens(getTokens().filter(t => t !== token)); }

function renderWatchChips() {
  for (const c of els.watchBox.querySelectorAll(".watchchip")) c.remove();
  const tokens = getTokens();
  for (const token of tokens) {
    const chip = document.createElement("span");
    chip.className = "watchchip";
    const name = document.createElement("span");
    name.textContent = token;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "watchchip-x";
    x.textContent = "×";
    x.title = `stop watching ${token}`;
    x.addEventListener("click", ev => { ev.preventDefault(); removeWatch(token); });
    chip.append(name, x);
    els.watchBox.insertBefore(chip, els.targetInput);
  }
  els.targetInput.placeholder = tokens.length ? "add…" : "user · owner/repo · org:name · global";
}

function applyWatch() {
  const parsed = parseTargets(state.raw);
  const prev = new Map(state.targets.map(t => [t.path, t]));
  const next = parsed.map(p => prev.get(p.path) || p);
  for (const t of state.targets) {
    if (!next.some(n => n.path === t.path)) clearTimeout(t.timer);
  }
  const added = next.filter(t => !prev.has(t.path));
  state.targets = next;
  renderWatchChips();
  updateWatchSummary();
  renderBoards();

  if (liveTargets().length === 0) {
    setStatus("idle", "idle");
    state.buffer.length = 0;
    els.wire.replaceChildren();
    els.wireEmpty.hidden = false;
    els.wireEmpty.classList.remove("is-error");
    els.wireEmpty.children[0].textContent = "not watching anything yet";
    els.wireEmpty.children[1].textContent = "add who to watch below — a user, owner/repo, org:name, or global";
    return;
  }

  if (els.wire.children.length === 0) {
    state.firstBatch = true;
    els.wireEmpty.hidden = false;
    els.wireEmpty.classList.remove("is-error");
    els.wireEmpty.children[0].textContent = next.length === 1
      ? `tuning in to ${next[0].label}…`
      : `tuning in to ${next.length} stations…`;
    els.wireEmpty.children[1].textContent = "first events land after the opening poll";
  }
  // Stagger the opening polls so a long watch list doesn't burst.
  added.forEach((t, i) => scheduleTarget(t, 300 + i * 1200));
}

// A ?watch= URL parameter overrides the saved list for this visit only,
// so a watch list can be shared as a link.
const urlWatch = new URLSearchParams(location.search).get("watch");
if (urlWatch !== null) state.raw = urlWatch;

els.targetInput.addEventListener("keydown", e => {
  if (e.key === "Enter" || e.key === "," || e.key === " ") {
    const v = els.targetInput.value.trim().replace(/,+$/, "");
    if (v) {
      e.preventDefault();
      els.targetInput.value = "";
      addWatch(v);
    } else if (e.key !== " ") {
      e.preventDefault();
    }
  } else if (e.key === "Backspace" && !els.targetInput.value) {
    const tokens = getTokens();
    if (tokens.length) removeWatch(tokens[tokens.length - 1]);
  }
});

els.targetInput.addEventListener("change", () => {
  const v = els.targetInput.value.trim();
  if (v) {
    els.targetInput.value = "";
    addWatch(v);
  }
});

function adoptToken(tok, persist) {
  state.token = tok;
  if (persist) localStorage.setItem("lw-token", tok);
  else localStorage.removeItem("lw-token");
  // The token changes the polling budget — bring every station's next poll in.
  liveTargets().forEach((t, i) => scheduleTarget(t, 500 + i * 600));
}

els.tokenInput.value = state.token;
els.tokenInput.addEventListener("change", () => {
  localStorage.removeItem("lw-use-gh");
  els.ghBtn.textContent = "use gh";
  els.tokenInput.placeholder = "optional — faster polls";
  adoptToken(els.tokenInput.value.trim(), true);
});

function setPaused(on) {
  state.paused = on;
  els.pauseBtn.setAttribute("aria-pressed", String(on));
  els.pauseBtn.textContent = on ? "resume" : "pause";
  if (liveTargets().length === 0) setStatus("idle", "idle");
  else steadyStatus();
  if (!on) runTrickle();
}

els.pauseBtn.addEventListener("click", () => setPaused(!state.paused));

addEventListener("keydown", e => {
  if (e.code === "Space" && !/INPUT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName || "")) {
    e.preventDefault();
    setPaused(!state.paused);
  }
});

/* ── the tauri shell: system-browser links + the updater ───────────── */

if (IS_APP) {
  // Inside the webview, links leave through the system browser.
  document.addEventListener("click", e => {
    const a = e.target.closest("a");
    if (!a || !/^https?:/.test(a.href)) return;
    e.preventDefault();
    window.__TAURI__.core.invoke("open_external", { url: a.href })
      .catch(() => window.open(a.href));
  });

  /* "use gh": borrow the gh CLI's login for the 5,000/hour budget. The
   * token lives only in memory here — gh stays its keeper on disk — and
   * linking tunes in your own circle (the people you follow) if it isn't
   * already on the watch list. */
  const ghLinked = tok => {
    els.tokenInput.value = "";
    els.tokenInput.placeholder = "using gh login";
    els.ghBtn.textContent = "gh ✓";
    adoptToken(tok, false);
  };

  els.ghBtn.hidden = false;
  els.ghBtn.addEventListener("click", async () => {
    let tok;
    try {
      tok = await window.__TAURI__.core.invoke("gh_token");
    } catch (err) {
      els.ghBtn.textContent = "gh ✗";
      els.ghBtn.title = String(err);
      setTimeout(() => { els.ghBtn.textContent = "use gh"; }, 4000);
      return;
    }
    localStorage.setItem("lw-use-gh", "1");
    ghLinked(tok);
    try {
      const res = await apiFetch("/user");
      if (res.ok) {
        const me = await res.json();
        const circle = `follows:${me.login}`;
        if (me.login && !getTokens().some(t => t.toLowerCase() === circle.toLowerCase())) {
          addWatch(circle);
        }
      }
    } catch { /* the login still counts even if the circle can't be fetched */ }
  });

  if (localStorage.getItem("lw-use-gh") === "1") {
    window.__TAURI__.core.invoke("gh_token").then(ghLinked).catch(() => {});
  }
}

/* Same contract as agenttilecli's updater, now hands-free: the binary
 * knows the commit it was built from and asks how far its channel has
 * moved on — origin/main for a repo build (which pulls and reinstalls via
 * livewire-update.sh), the newest release tag for an AppImage (which
 * downloads that build and swaps itself). The first sighting of a new
 * target starts the update unprompted; the chip narrates, and the dialog
 * stays as the manual path if a hands-free run couldn't start. The web
 * build has no baked commit and Pages always serves main, so none of
 * this runs in a plain browser. */
const SELF_REPO = "pl0xuee/github-livewire";

const updateChannel = IS_APP
  ? window.__TAURI__.core.invoke("update_channel").catch(() => "repo")
  : Promise.resolve("repo");
let updating = false;

async function startUpdate() {
  await window.__TAURI__.core.invoke("run_update");
  updating = true;
  els.updateWord.textContent = "updating…";
  els.updateSummary.textContent = (await updateChannel) === "appimage"
    ? "livewire is fetching the latest release build and restarts itself when it lands"
    : "updating — livewire rebuilds and restarts itself when it's done";
  els.updateSubjects.replaceChildren();
}

async function checkForUpdate() {
  if (!IS_APP || !BUILT_COMMIT || updating) return;
  const channel = await updateChannel;

  /* An AppImage can only ever become the newest release, so that tag is
   * its yardstick; a repo build tracks main itself. */
  let target = "main";
  if (channel === "appimage") {
    try {
      const rel = await apiFetch(`/repos/${SELF_REPO}/releases/latest`);
      if (!rel.ok) return;
      target = (await rel.json()).tag_name;
    } catch { return; }
    if (!target) return;
  }

  let d;
  try {
    const res = await apiFetch(`/repos/${SELF_REPO}/compare/${BUILT_COMMIT}...${target}`);
    if (!res.ok) return;
    d = await res.json();
  } catch { return; }
  if (d.status !== "ahead" || !d.ahead_by) return;

  const n = d.ahead_by;
  els.updateWord.textContent = `update · ${n}`;
  els.updateChip.hidden = false;
  els.updateSummary.textContent =
    `this build is ${n} commit${n === 1 ? "" : "s"} behind ${channel === "appimage" ? target : "origin/main"}`;
  els.updateSubjects.replaceChildren();
  for (const c of (d.commits || []).slice(-6).reverse()) {
    const li = document.createElement("li");
    li.textContent = (c.commit?.message || "").split("\n")[0];
    els.updateSubjects.append(li);
  }

  /* Hands-free, but one try per target: a run that took replaces this
   * build and the fresh binary compares clean, so reaching this line
   * twice for one sha means the last try didn't land — leave the chip
   * and dialog as the manual path instead of retrying forever. */
  const sha = d.commits?.at(-1)?.sha || target;
  if (localStorage.getItem("lw-auto-updated") !== sha) {
    localStorage.setItem("lw-auto-updated", sha);
    startUpdate().catch(() => {});
  }
}

els.updateChip.addEventListener("click", () => els.updateDialog.showModal());
els.updateLater.addEventListener("click", () => els.updateDialog.close());
els.updateNow.addEventListener("click", async () => {
  els.updateNow.disabled = true;
  try {
    await startUpdate();
  } catch {
    els.updateNow.disabled = false;
    els.updateSummary.textContent = (await updateChannel) === "appimage"
      ? "couldn't start the update — grab the newest AppImage from the releases page"
      : "couldn't start the updater — run livewire-update.sh from the repo";
  }
});

if (BUILT_COMMIT) els.revReadout.textContent = `rev ${BUILT_COMMIT.slice(0, 7)}`;
setTimeout(checkForUpdate, 8000);
setInterval(checkForUpdate, 6 * 3600 * 1000);

/* ── is github itself up? ──────────────────────────────────────────────
 * Statuspage feed, not the API — different host, so it deliberately does
 * NOT go through apiFetch and never sees the token. It also doesn't count
 * against any rate limit, so a tight cadence is fine. One summary fetch
 * carries the headline, every component's health, and active incidents. */

async function checkGithubStatus() {
  let d = null;
  try {
    const res = await fetch("https://www.githubstatus.com/api/v2/summary.json");
    d = await res.json();
  } catch { /* unreachable — could be them or us, so claim nothing */ }

  const map = {
    none: ["up", "github up"],
    minor: ["minor", "github degraded"],
    major: ["down", "github down"],
    critical: ["down", "github down"],
  };
  const [stateName, word] = map[d?.status?.indicator] || ["unknown", "github ?"];
  els.ghStatus.dataset.state = stateName;
  els.ghStatusWord.textContent = word;
  els.ghStatus.title = d?.status?.description
    ? `${d.status.description} — click for the service board`
    : "GitHub service status — click for the service board";
  els.statusOverall.textContent = d?.status?.description || "status feed unreachable";

  // Component lamps, minus Statuspage's self-promotional pseudo-component.
  els.statusComponents.replaceChildren();
  for (const c of (d?.components || []).filter(c => !/visit .*status/i.test(c.name || ""))) {
    const li = document.createElement("li");
    li.dataset.state = c.status || "unknown";
    const lamp = document.createElement("span");
    lamp.className = "lamp";
    const name = document.createElement("span");
    name.textContent = c.name || "";
    const status = document.createElement("span");
    status.className = "statuscomponent-word";
    status.textContent = (c.status || "unknown").replace(/_/g, " ");
    li.append(lamp, name, status);
    els.statusComponents.append(li);
  }

  // Active incidents, newest first, straight from the feed.
  els.statusIncidents.replaceChildren();
  const incidents = d?.incidents || [];
  if (d && incidents.length === 0) {
    const p = document.createElement("p");
    p.className = "statusquiet";
    p.textContent = "no active incidents";
    els.statusIncidents.append(p);
  }
  for (const inc of incidents.slice(0, 5)) {
    const div = document.createElement("div");
    div.className = "statusincident";
    const a = document.createElement("a");
    a.href = inc.shortlink || "https://www.githubstatus.com";
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = inc.name || "incident";
    const meta = document.createElement("div");
    meta.className = "statusincident-meta";
    const impact = document.createElement("span");
    impact.className = inc.impact === "critical" || inc.impact === "major" ? "is-critical" : "is-minor";
    impact.textContent = inc.impact || "unknown";
    meta.append(impact, document.createTextNode(
      ` · ${inc.status || ""} · ${inc.updated_at ? new Date(inc.updated_at).toLocaleString() : ""}`));
    div.append(a, meta);
    els.statusIncidents.append(div);
  }
}

els.ghStatus.addEventListener("click", () => els.statusDialog.showModal());
els.statusClose.addEventListener("click", () => els.statusDialog.close());

checkGithubStatus().then(() => {
  if (location.hash === "#status") els.statusDialog.showModal();
});
setInterval(checkGithubStatus, 180000);

/* ── go ────────────────────────────────────────────────────────────── */

buildLedger();
scope.start();
applyWatch();
