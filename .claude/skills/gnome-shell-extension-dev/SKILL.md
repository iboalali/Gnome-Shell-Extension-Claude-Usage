---
name: gnome-shell-extension-dev
description: Load, debug and test changes to this GNOME Shell extension (claude-usage@iboalali.github.io) in the running Wayland session without logging out. Use after editing extension.js or stylesheet.css, when an edit "has no effect", when reading the extension's logs, or when looking up how GNOME Shell itself implements something.
---

# Developing claude-usage live

This host runs GNOME Shell 50.1 on Wayland. UUID: `claude-usage@iboalali.github.io`. Source: this checkout.

## The trap: disable/enable alone does not load edited code

GJS caches every ES module by file URL for the life of the `gnome-shell` process. A plain `gnome-extensions disable && enable` only calls `disable()` and `enable()` again on the code loaded at login. The `[claude-usage]` log lines reappear anyway, so it looks like a reload happened. On Wayland, restarting the shell means logging out. Never log the user out, and never tell them a change is live without the loader confirming it (below).

## Live reload: `hot-reload`

The tool is `~/Documents/misc/gnome-ext-hotreload/hot-reload` (how it works: `~/Documents/misc/gnome-ext-hotreload/README.md`). A loader sits in `~/.local/share/gnome-shell/extensions/claude-usage@iboalali.github.io/`. On every enable, it copies this checkout to a new directory under `$XDG_RUNTIME_DIR/gnome-ext-hotreload/` and imports it from there, so the shell reads the current code. The loader is installed for this extension. `install.sh` replaces it with a plain symlink, so don't run `install.sh` while using the loader.

1. Check the syntax: `node --check extension.js`.
2. Load it: `~/Documents/misc/gnome-ext-hotreload/hot-reload reload claude-usage@iboalali.github.io`.
3. Read the output:
   - `[hot-reload] claude-usage@iboalali.github.io: enabled <path>` means the new code is running.
   - "the loader logged nothing" means the shell still runs the code from before the loader was installed. Tell the user that one logout and login is needed. After that, reloads work.
   - "Reload failed" is followed by the shell log since the reload. Fix the error and reload again. On a load error, the previous version keeps running.
4. If `status` doesn't say "Loader installed", run `hot-reload install "$PWD"` from this checkout, and tell the user that one logout is needed.

Still needs a logout: changes to `metadata.json` (`reload` warns; run `install` again first), and changes to the loader itself.

## Reload costs for this extension

Each reload runs `enable()`, which builds a new `ClaudeUsageIndicator`. Its constructor calls `_scheduleOauthTick(0)`, an immediate request to the rate-limited OAuth endpoint, and `_refreshCcusage()`, a `ccusage` run that takes tens of CPU-seconds. Batch edits and reload once, not after every small change. Never add code that makes reloads cheaper by polling OAuth more often. AGENTS.md forbids tightening the cadence.

## Rules for code that gets reloaded

`disable()` must undo everything `enable()` did. Anything left behind keeps running the old version next to the new one. Here that means `ClaudeUsageIndicator.destroy()` must keep removing both timers (`_ccusageTimerId`, `_oauthTimerId`) and cancelling both cancellables. Any new timer, signal on a shell object, or subprocess needs matching cleanup there. Signals connected on the indicator's own menu items go away with the actor.

## Logs

`journalctl -o cat --no-pager --since '-2 min' /usr/bin/gnome-shell | grep -E 'claude-usage|hot-reload'`, or `-f` to follow.

## Risky changes: isolated headless shell first

A JS exception can't crash the session. An infinite loop or a native crash takes down the real shell, and that logs the user out. Test changes that loop or patch shell internals in a throwaway headless shell first. Use a copy of the extension, separate data and settings, and no window:

```sh
T=$(mktemp -d); mkdir -p "$T/data/gnome-shell/extensions/claude-usage@iboalali.github.io"
cp extension.js metadata.json stylesheet.css "$T/data/gnome-shell/extensions/claude-usage@iboalali.github.io/"
XDG_DATA_HOME="$T/data" GSETTINGS_BACKEND=memory dbus-run-session -- bash -c '
  gnome-shell --headless --wayland --no-x11 --virtual-monitor 1920x1080 > "'"$T"'/shell.log" 2>&1 &
  for i in $(seq 100); do gnome-extensions info claude-usage@iboalali.github.io >/dev/null 2>&1 && break; sleep 0.2; done
  gnome-extensions enable claude-usage@iboalali.github.io; sleep 3
  gnome-extensions info claude-usage@iboalali.github.io | grep State
  kill %1; wait'
grep -E 'claude-usage|JS ERROR' "$T/shell.log"
```

`GSETTINGS_BACKEND=memory` keeps the test shell from writing `enabled-extensions` into the user's real dconf. `gnome-extensions` inside `dbus-run-session` talks to the test shell. The test shell still makes the real OAuth request and runs `ccusage`. For a visible test window, use the devkit command in AGENTS.md instead.

## Reading GNOME Shell's own source

The shell's JS is compiled into a GResource:

```sh
gresource list /usr/lib/gnome-shell/libshell-18.so | grep ui/panel
gresource extract /usr/lib/gnome-shell/libshell-18.so /org/gnome/shell/ui/panelMenu.js > /tmp/panelMenu.js
```

Relevant here: `ui/panel.js` (`addToStatusArea`), `ui/panelMenu.js`, `ui/popupMenu.js`, `ui/extensionSystem.js` (loading, enable/disable, stylesheets). The library name changes between GNOME versions: `ls /usr/lib/gnome-shell/`.
