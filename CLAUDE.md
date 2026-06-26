# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A GNOME Shell extension (UUID `claude-usage@iboalali.github.io`, ESM, Shell 45/46/47) that puts a live Claude Code usage indicator in the top bar. The entire extension is one file: `extension.js`. There is no build step and no package manager — `metadata.json` + `extension.js` + `stylesheet.css` is the whole shipping artifact.

## Architecture: two independent data paths

The indicator deliberately merges two unrelated sources so that one going down doesn't blank the panel:

1. **OAuth path** (`_refreshOauth`): GETs `https://api.anthropic.com/api/oauth/usage` using the bearer token read from `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`). Yields the `five_hour` and `seven_day` `utilization` percentages — the same numbers `/usage` shows inside Claude Code. Polled every **5–9 min with random jitter** (`OAUTH_BASE_SEC` ± `OAUTH_JITTER_SEC`). Last good response is persisted to `~/.cache/claude-usage/last-oauth.json` for warm starts.
2. **ccusage path** (`_refreshCcusage`): spawns `/usr/local/bin/ccusage blocks --active --json --offline` as a subprocess and parses stdout. Yields token totals, burn rate, cost, and remaining minutes for the active 5-hour block. Polled every `CCUSAGE_INTERVAL_SEC` (60 s) and on menu open.

The two timers, two cancellables, and two state objects are kept strictly separate inside `ClaudeUsageIndicator`. `_render()` is the only place they meet — it classifies each path independently (`_classifyOauth` → `fresh|stale|dead`, `_classifyCcusage` → `fresh|idle|dead`) and picks the top-bar emoji and dropdown text from the cross product. When editing render logic, preserve this split: do not couple the two paths' freshness or error states.

## OAuth endpoint constraints — do not relax these without thinking hard

The OAuth endpoint is **undocumented** and rate-limited. The current cadence and backoff exist to stay quiet:

- 5–9 min jittered polling — never tighten it.
- 429 → exponential backoff up to `OAUTH_BACKOFF_MAX_SEC` (30 min).
- 401 with the **same** token → treat as a real failure (back off). 401 with a **new** token (user re-logged in) → retry immediately. The `sameToken` check in `_refreshOauth` exists for this; don't drop it.
- Menu open refreshes ccusage but **not** OAuth (`open-state-changed` handler) — clicking the panel must not burn quota.
- "Refresh now" menu item also only refreshes ccusage, by design.

ROADMAP.md ("Things explicitly not in scope") forbids more aggressive polling and forbids reverse-engineering the Claude Code binary. Honour that.

## Rendering details that look like bugs but aren't

- The dropdown labels are forced into a monospace class (`claude-usage-mono`) and padded with `kv()` (`LABEL_WIDTH = 14`) so the Unicode progress bars in `fmtBar()` line up. Don't replace the padding with HTML/Pango — `St.Label` doesn't render either.
- `fmtBar()` uses 1/8-block partial characters (`▏▎▍▌▋▊▉`) for sub-step resolution at `BAR_WIDTH = 10`.
- The top-bar emoji set (`🟢 🟡 ⚪ ⚠️`) is meaningful, not decorative — see the table in README.md. `*` after a percentage means OAuth data is `stale` (older than 20 min) but not yet `dead`.

## Common commands

```sh
./install.sh                                    # symlink repo into ~/.local/share/gnome-shell/extensions/<uuid>
node --check extension.js                       # syntax check (no other tests exist)
gnome-extensions enable  claude-usage@iboalali.github.io
gnome-extensions disable claude-usage@iboalali.github.io
```

> ⚠️ On Wayland, `disable`/`enable` only toggle extension **state** — they do **not** load edited
> `extension.js`. To actually run new code you must restart `gnome-shell` (log out/in) or use the
> nested Shell. See "Live iteration loop" below — this trap eats hours if you don't know it.

Verify the OAuth endpoint by hand (useful when the indicator goes 🟡):

```sh
TOKEN=$(jq -r '.claudeAiOauth.accessToken' ~/.claude/.credentials.json)
curl -s -H "Authorization: Bearer $TOKEN" \
     -H "anthropic-beta: oauth-2025-04-20" \
     -H "Content-Type: application/json" \
     https://api.anthropic.com/api/oauth/usage | jq
```

## Live iteration loop (Wayland can't live-reload)

**`gnome-extensions disable && enable` does NOT reload edited code on Wayland.** GNOME Shell imports the extension's ESM module once and caches it for the life of the `gnome-shell` process; disable/enable only re-run `disable()`/`enable()` on the *already-loaded* instance — they never re-read `extension.js` from disk. The trap: the warm-start and "next OAuth tick in Xs" log lines *do* reappear on enable (because `enable()` re-runs), so it looks like a reload happened when it didn't. Edit the file, toggle the extension, and you'll silently keep running the old code — confirmed the hard way while shipping the absolute-reset-time rows.

`Alt+F2 r` (the in-place Shell restart) is X11-only, so on Wayland the only two ways to actually load new code are:

1. **Log out and back in** — full `gnome-shell` restart; the definitive test, against the real panel.
2. **Nested Shell** — spawns a fresh `gnome-shell` that reads `extension.js` from disk:

```sh
# Terminal 1 — tail Shell + extension logs
journalctl -f -o cat /usr/bin/gnome-shell | grep -i 'claude-usage\|claude'

# Terminal 2 — nested Shell (Ctrl+C and ↑+Enter to reload after edits)
WAYLAND_DISPLAY=wayland-0 MUTTER_DEBUG_DUMMY_MODE_SPECS=1920x1080 \
    dbus-run-session -- gnome-shell --nested --wayland
```

`WAYLAND_DISPLAY` must be set or the nested mutter has no host compositor to nest into, falls back to X11, and dies with `Unable to open display ':0'` / `Invalid MIT-MAGIC-COOKIE-1 key`. Use the actual socket name from `ls "$XDG_RUNTIME_DIR"/wayland-*` (usually `wayland-0`).

`MUTTER_DEBUG_DUMMY_MODE_SPECS` matters: without it the virtual monitor is ~1024×768 and the panel truncates the extension label to `…`, hiding regressions. The nested shell **shares dconf with the main session**, so don't `gnome-extensions disable/enable` from inside it — just kill and relaunch the process. Font metrics differ slightly from the real panel; verify UI tweaks with a real logout/login before calling them done.

`logTag()` writes to the GNOME Shell journal as `[claude-usage] …`. Use it liberally during debugging; the log line in `_scheduleOauthTick` ("next OAuth tick in Xs") is load-bearing for diagnosing rate-limit problems.

## Lifecycle and cleanup

`ClaudeUsageIndicator.destroy()` must release: both `GLib.timeout_add_seconds` IDs, both `Gio.Cancellable`s (cancel any in-flight ccusage subprocess and OAuth Soup request), and the `Soup.Session` (`abort()`). The `disable()` half of the GNOME Shell extension lifecycle calls this — leaks here cause "extension is unhealthy" errors on Shell restart. When adding any new timer, subprocess, or async I/O, wire it through the same pattern.

## Where to tweak behaviour

All tunables live as top-of-file constants in `extension.js`. README.md has the canonical table; ROADMAP.md (Phase 2.5) plans to migrate them into a GSettings schema + `prefs.js`. If you add a new tunable, add it to that table too.
