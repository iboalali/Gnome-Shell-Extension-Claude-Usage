# Claude Usage — GNOME Shell Extension

A live indicator in the GNOME top bar for your **Claude Code** usage, across one or more Claude accounts. It shows the same session and weekly percentages that `/usage` inside Claude Code shows, alongside locally computed token totals and the time left in the active 5-hour block.

The top bar has one small meter per account, then the active block:

```
W ▬▬▬▬▬▬▭▭   W 2.32M · 4h47m      ← meter per account, then tokens · time left
P ▬▭▭▭▭▭▭▭                          of the block in use (W = Work, P = Private)
```

Click it for a table with one column per account:

```
                 Work                 Private
Session          ▬▭▭▭▭▭▭▭   13%       ▭▭▭▭▭▭▭▭    0%
Week             ▬▬▬▬▬▬▭▭   78%       ▬▭▭▭▭▭▭▭    7%
Fable week       ▭▭▭▭▭▭▭▭    0%       —
Spend            ▭▭▭▭▭▭▭▭    0%       off
                 €0.00 of €0.00
Session resets   4h04m                not started
Week resets      Sat 16:59            Tue 11:59
───────────────────────────────────────────────
Tokens           2.32M                no active block
Burn             517k / min           —
Ends in          4h47m                —
───────────────────────────────────────────────
Open ccusage in terminal
Refresh now
```

The rows are St widgets in fixed-width columns, so the bars line up in any font.

## How it works

The indicator merges two independent data sources:

1. **OAuth percentages**: the authoritative session and weekly utilization numbers, fetched from `https://api.anthropic.com/api/oauth/usage` using the OAuth token Claude Code already maintains in `<config dir>/.credentials.json`. Polled every **5-9 min with random jitter** to stay well under the endpoint's rate limit. The last response is cached in `~/.cache/claude-usage/` for warm starts.
2. **Local token totals**: tokens, burn rate and time left for the active 5-hour block, parsed from the account's `<config dir>/projects/*.jsonl` transcripts via [`ccusage`][ccusage]. Checked every **5 min** and on menu open; ccusage only runs when a transcript changed since its last run. "Refresh now" always runs it.

The two paths are independent: if the OAuth endpoint is unreachable, that account's meter turns red and its column header says why, but ccusage tokens keep updating.

### Accounts

Each Claude Code config directory is one account. The `ACCOUNTS` constant at the top of `extension.js` lists them; by default `~/.claude` (Work) and `~/.claude-private` (Private, for a second login started with `CLAUDE_CONFIG_DIR="$HOME/.claude-private" claude`). An account whose directory does not exist is skipped, so a single-account setup shows one meter and one column.

Every account has its own OAuth polling, backoff and cache file, and its own ccusage run with `CLAUDE_CONFIG_DIR` set, so each account only counts its own transcripts. Each account polls its own quota at the usual 5-9 min, so two accounts make twice as many requests from this machine. The column header shows the plan from the credentials file (`Team · Max 5x`, `Pro`).

### Per-model weekly limits

Some models have their own weekly quota on top of the all-model one. The OAuth response reports these in its `limits` array as `weekly_scoped` entries, each tagged with a model name. The table gets one `<model> week` row per model that any account has a quota for, under the `Week` row. An account without that quota shows `—` in its column.

These matter because a per-model quota can be exhausted while the headline numbers still look fine: `Session` at 12% and `Week` at 38% tells you nothing about Fable sitting at 99%.

### Monthly spend

Accounts with extra usage enabled can spend money past their plan limits, up to a monthly cap. The OAuth response reports this in its `spend` object, and the table shows it as a `Spend` row: a bar with the share of the cap used, and the two amounts on the line beneath.

Amounts arrive as integer minor units plus an exponent, so `{"amount_minor": 2000, "exponent": 2}` renders as `20.00`. The currency comes from the same object; EUR, USD, GBP and JPY get a symbol, anything else gets the ISO code after the number (`8.00 SEK`).

An account with no cap has no `spend` object and shows `—`; the row disappears when no account has one. When extra usage is switched off, the cell reads `off`, with the server's reason beneath when it gives one.

### Top-bar meters and colors

Each account's meter shows its all-model weekly limit, colored by the `severity` the server assigns to that limit. Session and per-model limits are in the table, where each bar uses its own limit's severity.

| What you see | Meaning |
|---|---|
| Green fill | The weekly limit is `normal`. |
| Amber fill | The weekly limit is at `warning`. |
| Red fill | The weekly limit is at `critical`. |
| Faded fill | OAuth data is older than 20 min (stale). The column header says when it was updated. |
| Red, empty track | The account's OAuth path is dead (2 h old or 6 failures in a row). The column header gives the reason. |
| `⚠️ usage` | Every data path of every account is broken. |

The text after the meters is the active 5-hour block of the account used most recently (its last transcript entry is newest), led by the account letter. It disappears when no account has an active block.

An unrecognized severity counts as `warning` rather than being ignored, so a new value the server starts sending still reaches the panel.

[ccusage]: https://github.com/ryoppippi/ccusage

## Requirements

- **GNOME Shell 45 to 50** (uses the ESM module extension API).
- **Node.js ≥ 20.19.4** — required by ccusage 18.x.
- **`ccusage`** installed globally at `/usr/local/bin/ccusage`:
  ```sh
  sudo npm install -g ccusage
  ```
- **A Claude Pro / Max / Team subscription** signed in via `claude login` for the OAuth percentages to work. Without it the account's OAuth path stays dead and you only get the ccusage-based numbers.
- **`gnome-terminal`** (for the "Open ccusage in terminal" menu item).
  Replace the path in `extension.js` if you use a different terminal.

## Install

```sh
git clone https://github.com/iboalali/Gnome-Shell-Extension-Claude-Usage.git
cd Gnome-Shell-Extension-Claude-Usage
./install.sh                   # symlinks into ~/.local/share/gnome-shell/extensions/
# log out and back in (Wayland)
gnome-extensions enable claude-usage@iboalali.github.io
```

`install.sh` **symlinks** the clone into the extensions directory rather than
copying it, so your edits are what the shell loads. The trade-off: moving or
renaming the clone leaves the link dangling, and GNOME Shell skips broken
links at login without reporting an error — `gnome-extensions enable` just
answers `does not exist`, which looks like a missing extension rather than a
bad path. Re-run `./install.sh` from the new location to repoint it (it warns
when it finds a stale link), then log out and back in.

## Uninstall

```sh
gnome-extensions disable claude-usage@iboalali.github.io
rm ~/.local/share/gnome-shell/extensions/claude-usage@iboalali.github.io
rm -rf ~/.cache/claude-usage
```

## Configuration

No GUI yet (see [ROADMAP.md](ROADMAP.md)). Tweak constants at the top of
`extension.js`:

| Constant                  | Default                        | What it does                                           |
|---------------------------|--------------------------------|--------------------------------------------------------|
| `ACCOUNTS`                | `~/.claude` (W), `~/.claude-private` (P) | Config directories to show, with label, letter and cache file |
| `CCUSAGE_INTERVAL_SEC`    | `300`                          | ccusage poll interval                                  |
| `CCUSAGE`                 | `/usr/local/bin/ccusage`       | Path to the ccusage binary                             |
| `CCUSAGE_ARGS`            | `blocks --active --json --offline` | ccusage invocation flags                          |
| `OAUTH_BASE_SEC`          | `420` (7 min)                  | Base interval between OAuth fetches                    |
| `OAUTH_JITTER_SEC`        | `120` (±2 min)                 | Random jitter added to each OAuth tick                 |
| `OAUTH_BACKOFF_MAX_SEC`   | `1800` (30 min)                | Ceiling on exponential backoff after 429s              |
| `OAUTH_STALE_AFTER_MS`    | 20 min                         | When an account's bars fade as stale                  |
| `OAUTH_DEAD_AFTER_MS`     | 2 h                            | When an account's OAuth path is treated as dead        |
| `OAUTH_DEAD_MAX_FAILS`    | `6`                            | Consecutive non-2xx responses before marking dead      |

## Development

GNOME Shell on Wayland does **not** support live extension reloads (`Alt+F2 r` is X11-only). For a fast iteration loop, run a **devkit shell**: a second GNOME Shell shown in a window. It boots in about 2 seconds and picks up your latest `extension.js` on every restart.

### Live iteration loop (devkit shell)

The devkit shell's window is drawn by `/usr/libexec/mutter-devkit`, which comes in the `mutter-dev-bin` package:

```sh
sudo apt install mutter-dev-bin
```

Without it the shell still starts but runs headless, and its log says `Failed to launch devkit: Failed to execute child process "/usr/libexec/mutter-devkit"`.

Launch the dev shell. Its log goes to this terminal, not to the journal, so filter it here to see JS errors and the extension's own log lines:

```sh
MUTTER_DEBUG_DUMMY_MODE_SPECS=1920x1080 \
    dbus-run-session -- gnome-shell --devkit --wayland 2>&1 | grep -i 'claude'
```

The `MUTTER_DEBUG_DUMMY_MODE_SPECS` env var sizes the dev shell's virtual monitor. Without it the default is about 1024×768 and the panel truncates this extension's label to `…`. Set it to match your real monitor (or larger). Multi-monitor testing: chain values, e.g. `1920x1080,1280x720`. To simulate more monitors set `MUTTER_DEBUG_NUM_DUMMY_MONITORS=2`.

The extension auto-loads (it's already enabled in your main session's dconf), and its top-bar item appears as soon as the shell is up. To pick up an edit:

1. Save `extension.js`. The symlink means it's already in the extensions dir, so there is no copy step.
2. `Ctrl+C` in the terminal to kill the dev shell.
3. ↑ + Enter to relaunch. The fresh shell imports the module again, so your edits are live.

**GNOME Shell 45-48** has no `--devkit`. Use the older nested mode instead, with `WAYLAND_DISPLAY` set to your session's socket (from `ls "$XDG_RUNTIME_DIR"/wayland-*`, usually `wayland-0`):

```sh
WAYLAND_DISPLAY=wayland-0 MUTTER_DEBUG_DUMMY_MODE_SPECS=1920x1080 \
    dbus-run-session -- gnome-shell --nested --wayland
```

Without `WAYLAND_DISPLAY` the nested shell has no compositor to open its window in, falls back to X11 and dies with `Unable to open display ':0'`.

Caveats:

- The dev shell **shares dconf with your main session**, so toggling extensions inside it affects the main session too. Don't `gnome-extensions disable/enable` from inside the dev shell. Restart the process instead.
- Font metrics differ slightly from the real panel. Do a real logout/login before calling a UI tweak done.

### Alternatives if the devkit shell isn't an option

- **Logout / login**: slow (about 60 s) but always works.
- **Switch to "Ubuntu on Xorg"** at the GDM login screen (gear icon next to the Login button), on GNOME 48 and older, which still ship it. Under X11, `Alt+F2 → r` restarts the shell in place, giving you the same iteration loop without a second shell. Switch back to Wayland once you're done.

### Sanity checks without launching the shell

Syntax-check the JS:

```sh
node --check extension.js
```

Verify the OAuth endpoint by hand:
```sh
TOKEN=$(jq -r '.claudeAiOauth.accessToken' ~/.claude/.credentials.json)
curl -s -H "Authorization: Bearer $TOKEN" \
     -H "anthropic-beta: oauth-2025-04-20" \
     -H "Content-Type: application/json" \
     https://api.anthropic.com/api/oauth/usage | jq
```

## A note on the OAuth endpoint

`https://api.anthropic.com/api/oauth/usage` is **undocumented**. It powers
the `/usage` command inside Claude Code and is also used by community
projects like [`claude-code-statusline`][statusline] and [`CodexBar`][codexbar].
Anthropic's stated position is that OAuth tokens are intended for Claude
Code and Claude.ai; using them in third-party tools is, strictly read,
discouraged. This extension takes a conservative interpretation:

- It reads **your own** token from the file Claude Code itself maintains.
- It never writes to that file or attempts to refresh tokens.
- It polls at **5–9 min** intervals — substantially slower than `/usage`'s
  on-demand rate — to be a good citizen and stay under the endpoint's
  rate limit.
- It degrades gracefully if the endpoint stops answering: ccusage data continues to flow and the account's meter turns red.

If Anthropic ships an officially-supported way to query subscription
quotas, the OAuth path will be replaced with that.

[statusline]: https://github.com/ohugonnot/claude-code-statusline
[codexbar]: https://github.com/steipete/CodexBar

## Roadmap

Future work (settings UI, threshold notifications, EGO submission) lives in [ROADMAP.md](ROADMAP.md).

## License

GPL-3.0 — see [LICENSE](LICENSE).

## Acknowledgments

- [ccusage](https://github.com/ryoppippi/ccusage) for the JSONL parsing and
  block aggregation that one half of this extension is a thin GUI over.
- [`claude-code-statusline`](https://github.com/ohugonnot/claude-code-statusline)
  for the reference shell implementation of the OAuth endpoint call.
- [Anthropic's Claude Code](https://claude.com/claude-code).
