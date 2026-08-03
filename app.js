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

const state = {
  target: localStorage.getItem("lw-target") || "",
  token: localStorage.getItem("lw-token") || "",
  muted: new Set(JSON.parse(localStorage.getItem("lw-muted") || "[]")),
  etag: null,
  pollMs: 15000,
  pollAt: 0,            // epoch ms of the next poll
  pollTimer: null,
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
  targetInput: $("targetInput"), tokenInput: $("tokenInput"),
  pauseBtn: $("pauseBtn"), scope: $("scope"),
};

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ── target parsing ────────────────────────────────────────────────── */

function endpointFor(raw) {
  const t = raw.trim().replace(/^github\.com\//, "");
  if (!t || t === "global") return { path: "/events", label: "the global firehose" };
  if (t.startsWith("org:")) {
    const org = t.slice(4).trim();
    return { path: `/orgs/${org}/events`, label: `org ${org}` };
  }
  if (t.includes("/")) return { path: `/repos/${t}/events`, label: t };
  return { path: `/users/${t}/events`, label: `@${t}` };
}

/* ── polling ───────────────────────────────────────────────────────── */

async function poll() {
  clearTimeout(state.pollTimer);
  setStatus(state.paused ? "paused" : "sync", state.paused ? "paused" : "sync");

  const { path } = endpointFor(state.target);
  const headers = { Accept: "application/vnd.github+json" };
  if (state.etag) headers["If-None-Match"] = state.etag;
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  let res;
  try {
    res = await fetch(`${API}${path}?per_page=100`, { headers });
  } catch {
    setStatus("error", "offline");
    schedule(30000);
    return;
  }

  readRateLimit(res);

  if (res.status === 304) {
    setStatus(state.paused ? "paused" : "live", state.paused ? "paused" : "live");
    schedule(state.pollMs);
    return;
  }

  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    const wait = Math.max(30000, (reset || Date.now() + 60000) - Date.now() + 2000);
    setStatus("limit", "rate-limited");
    showEmptyError(`rate limit reached — resuming ${new Date(Date.now() + wait).toLocaleTimeString()}`,
      "add a token below to raise the ceiling");
    schedule(wait);
    return;
  }

  if (res.status === 404) {
    setStatus("error", "not found");
    showEmptyError(`nothing at "${state.target.trim()}"`, "check the handle — user, owner/repo, or org:name");
    schedule(120000);
    return;
  }

  if (!res.ok) {
    setStatus("error", `http ${res.status}`);
    schedule(60000);
    return;
  }

  state.etag = res.headers.get("etag");
  const wanted = Math.max(10, Number(res.headers.get("x-poll-interval") || 0));
  // Without a token the budget is 60 requests/hour; don't spend it faster
  // than one a minute no matter what the header offers.
  state.pollMs = Math.max(wanted, state.token ? 10 : 60) * 1000;

  let events;
  try { events = await res.json(); } catch { events = []; }

  // Schedule before ingesting so the trickle paces itself against the real
  // window until the next poll, not a stale timestamp.
  schedule(state.pollMs);
  if (Array.isArray(events)) ingest(events);

  setStatus(state.paused ? "paused" : "live", state.paused ? "paused" : "live");
}

function schedule(ms) {
  state.pollAt = Date.now() + ms;
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(poll, ms);
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
  const runway = Math.max(2000, state.pollAt - Date.now() - 3000);
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
  renderBoard(els.hotRepos, state.repoTally, 7, name => `https://github.com/${name}`);
  renderBoard(els.hotActors, state.actorTally, 5, name => `https://github.com/${name}`, true);
}

function renderBoard(root, tally, n, hrefFor, plain = false) {
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  root.replaceChildren();
  if (top.length === 0) {
    const li = document.createElement("li");
    li.className = "board-empty";
    li.textContent = "waiting for traffic";
    root.append(li);
    return;
  }
  const max = top[0][1];
  for (const [name, count] of top) {
    const li = document.createElement("li");
    li.className = "boardrow";
    const a = document.createElement("a");
    a.className = "boardrow-name";
    a.href = hrefFor(name);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = name;
    const c = document.createElement("span");
    c.className = "boardrow-count";
    c.textContent = count;
    li.append(a, c);
    if (!plain) {
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
  if (!state.pollAt) return;
  const s = Math.max(0, Math.round((state.pollAt - Date.now()) / 1000));
  els.pollReadout.textContent = `next poll ${s}s`;
  renderTotals();
}, 1000);

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
    step();
    draw();
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

function retune() {
  state.etag = null;
  state.buffer.length = 0;
  state.firstBatch = true;
  els.wire.replaceChildren();
  els.wireEmpty.hidden = false;
  els.wireEmpty.classList.remove("is-error");
  const { label } = endpointFor(state.target);
  els.wireEmpty.children[0].textContent = `tuning in to ${label}…`;
  els.wireEmpty.children[1].textContent = "first events land after the opening poll";
  poll();
}

els.targetInput.value = state.target;
els.targetInput.addEventListener("change", () => {
  state.target = els.targetInput.value;
  localStorage.setItem("lw-target", state.target);
  retune();
});

els.tokenInput.value = state.token;
els.tokenInput.addEventListener("change", () => {
  state.token = els.tokenInput.value.trim();
  localStorage.setItem("lw-token", state.token);
  retune();
});

function setPaused(on) {
  state.paused = on;
  els.pauseBtn.setAttribute("aria-pressed", String(on));
  els.pauseBtn.textContent = on ? "resume" : "pause";
  setStatus(on ? "paused" : "live", on ? "paused" : "live");
  if (!on) runTrickle();
}

els.pauseBtn.addEventListener("click", () => setPaused(!state.paused));

addEventListener("keydown", e => {
  if (e.code === "Space" && !/INPUT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName || "")) {
    e.preventDefault();
    setPaused(!state.paused);
  }
});

/* ── go ────────────────────────────────────────────────────────────── */

buildLedger();
renderBoards();
scope.start();
poll();
