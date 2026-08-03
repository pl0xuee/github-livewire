# livewire

A live telemetry board for GitHub's public event stream — pushes, stars, forks,
releases, pull requests, issues and more, streaming in as they happen.

**Live at <https://pl0xuee.github.io/github-livewire/>**

![livewire screenshot](screenshot.png)

## What it does

- **The wire** — a live feed of public GitHub events, each narrated ("pushed 3
  commits to…", "published v2.1 of…") with the actor, repo, commit sha/message
  or title, and a colour-coded channel rail.
- **The seismograph** — a scrolling trace in the header that kicks with every
  event; colour ticks along its floor mark which channel fired.
- **Ledger** — per-channel counters with meters. Click a channel to mute it on
  the wire (counters keep counting).
- **Hot repos / busy hands** — session leaderboards of the most active
  repositories and users.
- **Watch anything, or nothing** — livewire starts idle and polls nothing
  until you tell it who to watch: users (`torvalds`), repos
  (`rust-lang/rust`), orgs (`org:mozilla`), or `global` for the public
  firehose. Type a handle and press Enter — it pins as a chip; × unpins it.
  Every leaderboard row also grows a **+** on hover that adds it to the
  watch. Each target gets its own poll loop and they merge onto one wire,
  deduplicated. A watch list is shareable as a link:
  `?watch=torvalds,rust-lang/rust`.
- **Your circle** — `follows:you` watches everyone a user follows through a
  single poll target (GitHub's received-events feed), instead of adding
  fifty chips one by one.
- **Service lamp** — a **github up / degraded / down** chip in the header,
  fed by githubstatus.com. Click it for the service board: per-component
  health (Git, API, Actions, Pages, …) and active incidents, refreshed
  every three minutes. Also reachable at `#status`.
- Pause with the button or the space bar. Session totals and events/min in the
  ledger footer; API budget and next-poll countdown in the desk bar.

## Running it

It's a static page — no build, no dependencies. Serve the folder any way you
like:

```sh
python -m http.server 8080
# or: npx serve
```

then open <http://localhost:8080>.

## The desktop app

`src-tauri/` wraps the same three files in a Tauri shell — a native window,
a few megabytes, no bundled browser. Build and install it into your launcher
with:

```sh
./install.sh
```

(needs Rust and `webkit2gtk-4.1`), or grab the **AppImage** from the
[latest release](https://github.com/pl0xuee/github-livewire/releases) —
CI builds one for every version tag. The build stamps the commit it was made
from into the page; the app periodically asks GitHub how far `origin/main`
has moved on and, when it has, lights a green **update** chip in the header —
click it to see what's new and update in place (`livewire-update.sh` pulls,
rebuilds, reinstalls, and restarts). Links open in your system browser.

## Rate limits

The GitHub Events API allows 60 unauthenticated requests an hour, so livewire
splits that budget across your watch list — one target polls once a minute,
three targets every three minutes each — and streams every batch out over the
interval (`304 Not Modified` responses are free, so quiet targets cost
nothing). Drop a
[personal access token](https://github.com/settings/tokens) (no scopes needed)
into the token field for 5,000/hour and faster polls. The token is stored only
in your browser's localStorage and sent only to `api.github.com`.

In the desktop app there's a faster road: the **use gh** button borrows the
`gh` CLI's existing login for the session — 5,000/hour, nothing new written
to disk — and tunes in your own circle (`follows:you`) automatically.

**Where tokens can and can't go:** livewire never acquires a token by
itself. One exists only after you paste one or press **use gh** on your own
machine, it is attached by a single code path that talks exclusively to
`api.github.com`, and a gh-borrowed token is held in memory only — `gh`
stays its keeper on disk. The hosted web page has no gh access at all; the
button doesn't exist there.

## Palette

The gunmetal ramp, filament light, and channel hues are borrowed from
[agenttilecli]. Chart fills are the same hues stepped down in OKLCH to sit in
the dark-surface chart band — the set passes lightness, chroma, colour-vision
(protan/deutan ΔE) and contrast checks.

[agenttilecli]: https://github.com/pl0xuee/agenttilecli

## License

MIT
