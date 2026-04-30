# Claude Usage — GNOME Shell Extension

A live indicator in the GNOME top bar for your **Claude Code** usage.
Shows the same session and weekly percentages that `/usage` inside Claude
Code shows, alongside locally-computed token totals and the time remaining
in the active 5-hour billing window. Click for a dropdown with the full
breakdown.

```
🟢 12% · 1.2M · 3h12m            ← top bar (session% · tokens · time-left)

  Session (5h): [█▏░░░░░░░░]  12%  resets in 3h12m   ← click → dropdown
  Week (7d):    [███▏░░░░░░]  38%  resets in 4d18h     (monospace, ASCII bars)
  ─────────────
  Tokens:       1.2M
  Burn:         16.5k tok/min
  Cost:         $4.20
  Ends in:      3h12m
  ─────────────
  Open ccusage in terminal
  Refresh now
```

## How it works

The indicator merges two independent data sources:

1. **OAuth percentages** — the authoritative session and weekly utilization
   numbers, fetched from `https://api.anthropic.com/api/oauth/usage` using
   the OAuth token Claude Code already maintains in
   `~/.claude/.credentials.json`. Polled every **5–9 min with random jitter**
   to stay well under the endpoint's rate limit. Last response is cached at
   `~/.cache/claude-usage/last-oauth.json` for warm starts.
2. **Local token totals** — burn rate, cost, time-remaining for the active
   5-hour block, parsed from your `~/.claude/projects/*.jsonl` transcripts
   via [`ccusage`][ccusage]. Polled every **60 s** and on menu open.

The two paths are independent: if the OAuth endpoint is unreachable the
indicator drops the percentage and switches to a yellow `🟡` icon, but
ccusage tokens keep updating.

| Top-bar emoji | Meaning |
|---|---|
| `🟢` | Both sources fresh. Top bar shows percentage. |
| `🟢 12%*` | OAuth response is older than 20 min; ccusage still fresh. |
| `🟡` | OAuth endpoint dead/unreachable; ccusage still working. |
| `⚪` | No active block and 0% session usage. |
| `⚠️` | Both sources broken. |

[ccusage]: https://github.com/ryoppippi/ccusage

## Requirements

- **GNOME Shell 45, 46, or 47** (uses the ESM module extension API).
- **Node.js ≥ 20.19.4** — required by ccusage 18.x.
- **`ccusage`** installed globally at `/usr/local/bin/ccusage`:
  ```sh
  sudo npm install -g ccusage
  ```
- **A Claude Pro / Max / Team subscription** signed in via `claude login`
  for the OAuth percentages to work. Without it the OAuth path stays
  `🟡` (unavailable) and you only get the ccusage-based view.
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
| `CCUSAGE_INTERVAL_SEC`    | `60`                           | ccusage poll interval                                  |
| `CCUSAGE`                 | `/usr/local/bin/ccusage`       | Path to the ccusage binary                             |
| `CCUSAGE_ARGS`            | `blocks --active --json --offline` | ccusage invocation flags                          |
| `OAUTH_BASE_SEC`          | `420` (7 min)                  | Base interval between OAuth fetches                    |
| `OAUTH_JITTER_SEC`        | `120` (±2 min)                 | Random jitter added to each OAuth tick                 |
| `OAUTH_BACKOFF_MAX_SEC`   | `1800` (30 min)                | Ceiling on exponential backoff after 429s              |
| `OAUTH_STALE_AFTER_MS`    | 20 min                         | When the top-bar percentage gets the `*` stale marker |
| `OAUTH_DEAD_AFTER_MS`     | 2 h                            | When OAuth is treated as dead and the % is dropped     |
| `OAUTH_DEAD_MAX_FAILS`    | `6`                            | Consecutive non-2xx responses before marking dead      |

## Development

GNOME Shell on Wayland does **not** support live extension reloads
(`Alt+F2 r` is X11-only). For a fast iteration loop, run a **nested
shell** in a window — it boots in ~2 seconds and picks up your latest
`extension.js` on every restart.

### Live iteration loop (nested shell)

Open two terminals:

**Terminal 1** — tail JS errors and the extension's own log lines so
crashes are visible the moment they happen:

```sh
journalctl -f -o cat /usr/bin/gnome-shell | grep -i 'claude-usage\|claude'
```

**Terminal 2** — the dev shell:

```sh
MUTTER_DEBUG_DUMMY_MODE_SPECS=1920x1080 dbus-run-session -- gnome-shell --nested --wayland
```

The `MUTTER_DEBUG_DUMMY_MODE_SPECS` env var sizes the nested shell's
virtual monitor — without it the default is ~1024×768 and the panel
truncates this extension's label to `…`. Set it to match your real
monitor (or larger). Multi-monitor testing: chain values, e.g.
`1920x1080,1280x720`. To simulate more monitors set
`MUTTER_DEBUG_NUM_DUMMY_MONITORS=2`.

This opens a small GNOME Shell *inside* a window. The extension
auto-loads (it's already enabled in your main session's dconf), so
its top-bar item appears within ~60 s. To pick up an edit:

1. Save `extension.js` (the symlink means it's already in the
   extensions dir — no copy step).
2. Focus terminal 2, `Ctrl+C` to kill the nested shell.
3. ↑ + Enter to relaunch — fresh module imports, edits are live.

Caveats:

- The nested shell **shares dconf with your main session**, so toggling
  extensions inside it affects the main session too. Don't `gnome-extensions
  disable/enable` from inside the nested shell — just restart the process.
- The nested window renders smaller and font metrics differ slightly from
  the real panel. Do a real logout/login before calling a UI tweak done.

### Alternatives if the nested shell isn't an option

- **Logout / login** — slow (~60 s) but always works.
- **Switch to "Ubuntu on Xorg"** at the GDM login screen (gear icon
  next to the Login button). Under X11, `Alt+F2 → r` restarts the
  shell in place, giving you the same iteration loop without a nested
  window. Switch back to Wayland once you're done.

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
- It degrades gracefully if the endpoint stops answering: ccusage data
  continues to flow and the panel switches to `🟡`.

If Anthropic ships an officially-supported way to query subscription
quotas, the OAuth path will be replaced with that.

[statusline]: https://github.com/ohugonnot/claude-code-statusline
[codexbar]: https://github.com/steipete/CodexBar

## Roadmap

Future work — settings UI, threshold notifications, multi-account, EGO
submission — lives in [ROADMAP.md](ROADMAP.md).

## License

GPL-3.0 — see [LICENSE](LICENSE).

## Acknowledgments

- [ccusage](https://github.com/ryoppippi/ccusage) for the JSONL parsing and
  block aggregation that one half of this extension is a thin GUI over.
- [`claude-code-statusline`](https://github.com/ohugonnot/claude-code-statusline)
  for the reference shell implementation of the OAuth endpoint call.
- [Anthropic's Claude Code](https://claude.com/claude-code).
