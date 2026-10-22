# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` points here.

## What this is

A GNOME Shell extension (UUID `claude-usage@iboalali.github.io`, ESM, Shell 45-50) that puts a live Claude Code usage indicator in the top bar, for one or more Claude accounts. The entire extension is one file: `extension.js`. There is no build step and no package manager: `metadata.json` + `extension.js` + `stylesheet.css` is the whole shipping artifact.

## Architecture: accounts, each with two independent data paths

An account is one Claude Code config directory, listed in `ACCOUNTS` (default `~/.claude` as Work and `~/.claude-private` as Private; missing directories are skipped). Each `Account` object owns both data paths for its directory. The indicator merges two unrelated sources per account so that one going down doesn't blank the panel:

1. **OAuth path** (`_refreshOauth`): GETs `https://api.anthropic.com/api/oauth/usage` using the bearer token read from `<configDir>/.credentials.json` (`claudeAiOauth.accessToken`; `subscriptionType` and `rateLimitTier` from the same object become the plan in the column header). Yields the `five_hour` and `seven_day` `utilization` percentages (the same numbers `/usage` shows inside Claude Code), plus a `limits[]` array carrying a server-assigned `severity` per limit and the per-model weekly quotas (`kind: "weekly_scoped"`, model in `scope.model.display_name`). The dedicated `seven_day_opus`/`seven_day_sonnet` fields are null in practice; `limits[]` is the source for per-model numbers. Polled every **5-9 min with random jitter** (`OAUTH_BASE_SEC` ± `OAUTH_JITTER_SEC`). Last good response is persisted to `~/.cache/claude-usage/<cacheFile>` for warm starts (Work keeps the original `last-oauth.json`).
2. **ccusage path** (`refreshCcusage`): spawns `/usr/local/bin/ccusage blocks --active --json --offline` with `CLAUDE_CONFIG_DIR=<configDir>`, so it reads only that account's transcripts, and parses stdout. Yields token totals, burn rate, cost, and remaining minutes for the active 5-hour block. Checked every `CCUSAGE_INTERVAL_SEC` (300 s) and on menu open, never more than one run at a time. Each run rescans the whole transcript history (about 70 CPU-seconds and close to 1 GB on a 3.7 GB history), so a check first runs `find` (`TRANSCRIPT_CHECK_CMD`) and skips ccusage unless a `.jsonl` changed since the last run started. The check is bypassed by "Refresh now", by an error or missing data, and by an active block whose `endTime` has passed. "Ends in" is computed from the block's `endTime`, so it keeps counting down across skipped runs.

Inside each `Account`, the two timers, two cancellables, and two state objects are kept strictly separate, and accounts share nothing but the `Soup.Session`. `ClaudeUsageIndicator._render()` is the only place paths and accounts meet. It classifies each path of each account independently (`classifyOauth` → `fresh|stale|dead`, `classifyCcusage` → `fresh|idle|dead`) and builds the top-bar meters and the dropdown table from that. When editing render logic, preserve this split: do not couple the two paths' freshness or error states, or one account's state to another's.

## OAuth endpoint constraints: do not relax these without thinking hard

The OAuth endpoint is **undocumented** and rate-limited. The current cadence and backoff exist to stay quiet. They apply per account, since each account polls with its own token:

- 5-9 min jittered polling. Never tighten it.
- 429 → exponential backoff up to `OAUTH_BACKOFF_MAX_SEC` (30 min).
- 401 with the **same** token → treat as a real failure (back off). 401 with a **new** token (user re-logged in) → retry immediately. The `sameToken` check in `_refreshOauth` exists for this; don't drop it.
- Menu open refreshes ccusage but **not** OAuth (`open-state-changed` handler). Clicking the panel must not burn quota.
- "Refresh now" menu item also only refreshes ccusage, by design.

ROADMAP.md ("Things explicitly not in scope") forbids more aggressive polling and forbids reverse-engineering the Claude Code binary. Honor that.

## Rendering details that look like bugs but aren't

- The dropdown is a table of St widgets, rebuilt on every render: a fixed-width label column (`.claude-usage-row-label`), then one fixed-width column per account (`.claude-usage-cell`). Alignment comes from those CSS widths, not from padding text, so it holds in any font.
- A bar is a track `St.Widget` with a fill `St.Widget` inside whose CSS width is set in code as a share of the track. `METER_PX` and `BAR_PX` in `extension.js` must match the track widths in `stylesheet.css`. Non-zero values get at least 2px so 1% stays visible.
- Bar colors come only from the server's `severity` (`.claude-usage-sev-normal|warning|critical`), never from the percentage: a `normal` limit at 90% is green. A top-bar meter shows only the account's all-model weekly limit (`seven_day`, severity from the `weekly_all` entry); session and per-model limits appear in the table only. See the table in README.md.
- Stale OAuth data fades the fill (`opacity`), dead OAuth empties the meter and tints its track red, and `⚠️ usage` is reserved for every path of every account being dead.
- St CSS rejects negative margins: a `margin-top: -6px` gave the menu an infinite height and it never appeared. Use spacing on the parent box instead.
- `ClaudeUsageIndicator` wraps a `PanelMenu.Button` instead of subclassing it. A GObject subclass registers a GType named after the extension, and loading the module a second time in the same Shell (the hot-reload loader) fails with "Type name ... is already registered".

## Common commands

```sh
./install.sh                                    # symlink repo into ~/.local/share/gnome-shell/extensions/<uuid>
node --check extension.js                       # syntax check (no other tests exist)
gnome-extensions enable  claude-usage@iboalali.github.io
gnome-extensions disable claude-usage@iboalali.github.io
```

> ⚠️ On Wayland, `disable`/`enable` only toggle extension **state**. They do **not** load edited `extension.js`. To actually run new code, restart `gnome-shell` (log out/in) or use the devkit Shell. See "Live iteration loop" below; this trap eats hours if you don't know it.

> ⚠️ The install is a **symlink**, so moving or renaming this checkout leaves it dangling, and GNOME Shell skips broken links at login **silently**. `gnome-extensions info|enable <uuid>` then answers "does not exist" (exit 2), which reads like a missing extension rather than the path problem it is. Re-run `./install.sh` from the new location to repoint it; it detects a stale link and warns. The running Shell holds no record of the extension until a logout/login, so `enable` keeps failing until then. It is also unnecessary when the UUID is still listed in `gsettings get org.gnome.shell enabled-extensions`, since the indicator then returns on its own.

Verify the OAuth endpoint by hand (useful when the indicator goes 🟡):

```sh
TOKEN=$(jq -r '.claudeAiOauth.accessToken' ~/.claude/.credentials.json)
curl -s -H "Authorization: Bearer $TOKEN" \
     -H "anthropic-beta: oauth-2025-04-20" \
     -H "Content-Type: application/json" \
     https://api.anthropic.com/api/oauth/usage | jq
```

## Live iteration loop (Wayland can't live-reload)

**`gnome-extensions disable && enable` does NOT reload edited code on Wayland.** GNOME Shell imports the extension's ESM module once and caches it for the life of the `gnome-shell` process; disable/enable only re-run `disable()`/`enable()` on the *already-loaded* instance. They never re-read `extension.js` from disk. The trap: the warm-start and "next OAuth tick in Xs" log lines *do* reappear on enable (because `enable()` re-runs), so it looks like a reload happened when it didn't. Edit the file, toggle the extension, and you'll silently keep running the old code.

`Alt+F2 r` (the in-place Shell restart) is X11-only, so on Wayland the only two ways to actually load new code are:

1. **Log out and back in**: a full `gnome-shell` restart; the definitive test, against the real panel.
2. **Devkit Shell**: spawns a fresh `gnome-shell` that reads `extension.js` from disk and shows it in a viewer window on your desktop:

```sh
# Ctrl+C and ↑+Enter to reload after edits
MUTTER_DEBUG_DUMMY_MODE_SPECS=1920x1080 \
    dbus-run-session -- gnome-shell --devkit --wayland 2>&1 | grep -i 'claude'
```

The viewer is `/usr/libexec/mutter-devkit` from the `mutter-dev-bin` package (`sudo apt install mutter-dev-bin`). Without it the Shell still starts but runs headless, and the log says `Failed to launch devkit: Failed to execute child process "/usr/libexec/mutter-devkit"`. The devkit Shell picks the next free Wayland socket (`wayland-1`) on its own, so it needs no `WAYLAND_DISPLAY`.

Its log goes to the terminal that launched it, not to the journal, so `journalctl -f /usr/bin/gnome-shell` shows only the main session's Shell. Look for the `[claude-usage]` lines in the launching terminal.

`--devkit` replaced `--nested` in GNOME 49. On Shell 45-48 the equivalent is `WAYLAND_DISPLAY=wayland-0 MUTTER_DEBUG_DUMMY_MODE_SPECS=1920x1080 dbus-run-session -- gnome-shell --nested --wayland`. There `WAYLAND_DISPLAY` must be set (the actual socket from `ls "$XDG_RUNTIME_DIR"/wayland-*`), or the nested mutter has no host compositor, falls back to X11 and dies with `Unable to open display ':0'` / `Invalid MIT-MAGIC-COOKIE-1 key`.

`MUTTER_DEBUG_DUMMY_MODE_SPECS` matters: without it the virtual monitor is about 1024×768 and the panel truncates the extension label to `…`, hiding regressions. The test Shell **shares dconf with the main session**, so don't `gnome-extensions disable/enable` from inside it. Kill and relaunch the process instead. Font metrics differ slightly from the real panel, so verify UI tweaks with a real logout/login before calling them done.

`logTag()` writes to the GNOME Shell journal as `[claude-usage] …`. Use it liberally during debugging; the log line in `_scheduleOauthTick` ("next OAuth tick in Xs") is load-bearing for diagnosing rate-limit problems.

## Lifecycle and cleanup

`Account.destroy()` must release, for its account: both `GLib.timeout_add_seconds` IDs, both `Gio.Cancellable`s (stop waiting on in-flight ccusage output and cancel the OAuth Soup request), and the running ccusage or `find` subprocess (`force_exit()`, since canceling only stops the wait and leaves the process running). `ClaudeUsageIndicator.destroy()` calls it for every account, then aborts the shared `Soup.Session` and destroys the button. The `disable()` half of the GNOME Shell extension lifecycle calls this. Leaks here cause "extension is unhealthy" errors on Shell restart. When adding any new timer, subprocess, or async I/O, wire it through the same pattern.

## Where to tweak behavior

All tunables live as top-of-file constants in `extension.js`. README.md has the canonical table; ROADMAP.md (Phase 2.5) plans to migrate them into a GSettings schema + `prefs.js`. If you add a new tunable, add it to that table too.
