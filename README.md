# Claude Usage — GNOME Shell Extension

A live indicator in the GNOME top bar for your active **Claude Code** session
usage. Shows tokens used and time remaining in the current 5-hour billing
window; click for a dropdown with burn rate, cost, and projected end.

```
🟢 1.2M · 3h12m       ← top bar

  Tokens:  1.2M       ← click → dropdown
  Burn:    16.5k tok/min
  Cost:    $4.20
  Ends in: 3h 12m
  ─────────────
  Open ccusage in terminal
  Refresh now
```

> Phase 1 reads token totals from your local `~/.claude/projects/*.jsonl`
> transcripts via [`ccusage`][ccusage]. Server-side session/weekly rate-limit
> percentages (the ones shown by `/usage` inside Claude Code) are not yet
> exposed; that's a future enhancement.

[ccusage]: https://github.com/ryoppippi/ccusage

## Requirements

- **GNOME Shell 45, 46, or 47** (uses the ESM module extension API).
- **Node.js ≥ 20.19.4** — required by ccusage 18.x.
- **`ccusage`** installed globally at `/usr/local/bin/ccusage`:
  ```sh
  sudo npm install -g ccusage
  ```
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
```

## Configuration

No GUI yet. Tweak constants at the top of `extension.js`:

| Constant       | Default                      | What it does                          |
|----------------|------------------------------|---------------------------------------|
| `REFRESH_SEC`  | `60`                         | How often to re-poll ccusage          |
| `CCUSAGE`      | `/usr/local/bin/ccusage`     | Path to the ccusage binary            |
| `CCUSAGE_ARGS` | `blocks --active --json --offline` | ccusage invocation flags        |

## Development

GNOME Shell on Wayland does **not** support live extension reloads
(`Alt+F2 r` is X11-only). Two options:

1. **Logout/login** after edits — slow but reliable.
2. **Nested shell** for tighter loops:
   ```sh
   dbus-run-session -- gnome-shell --nested --wayland
   ```
   Enable the extension inside the nested instance.

Tail JS errors:
```sh
journalctl -f -o cat /usr/bin/gnome-shell | grep -i claude
```

Syntax-check `extension.js` without launching the shell:
```sh
node --check extension.js
```

## License

GPL-3.0 — see [LICENSE](LICENSE).

## Acknowledgments

- [ccusage](https://github.com/ryoppippi/ccusage) for the JSONL parsing and
  block aggregation that this extension is just a thin GUI over.
- [Anthropic's Claude Code](https://claude.com/claude-code).
