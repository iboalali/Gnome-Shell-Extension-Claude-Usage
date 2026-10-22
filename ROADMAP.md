# Roadmap

This file tracks work that is **explicitly out of scope** for the shipped
Phase 1 + Phase 2 indicator but is on the table for future iterations.
Order is rough priority, not guaranteed.

## Phase 2.5 — Settings UI (`prefs.js`)

Surface the constants currently hard-coded at the top of `extension.js` in a
GNOME Extensions preferences pane, backed by a GSettings schema.

What to expose:

- ccusage refresh interval (default 300 s).
- OAuth base interval and jitter range (defaults 420 ± 120 s).
- Toggle: include `seven_day_sonnet` row in the dropdown.
- Toggle: show cost in USD vs hide it (some users prefer tokens-only).
- Path overrides for the `ccusage` binary and the credentials file (mostly
  for users who installed via `nvm` or run a non-standard layout).

Notes:

- Will introduce a `schemas/org.gnome.shell.extensions.claude-usage.gschema.xml`,
  compiled to `gschemas.compiled` at install time. `install.sh` will need to
  run `glib-compile-schemas`.
- Keep `extension.js` reading defaults from the schema, not from the literal
  constants — same source of truth for both UI and runtime.

## Threshold notifications

`notify-send`-style desktop notifications when usage crosses configurable
thresholds. The OAuth percentages are the natural input.

Behaviour to design:

- Per-window thresholds (default: 50 %, 80 %, 95 % for both 5 h and 7 d).
- One notification per (threshold, window, reset cycle) — never spam: once
  the 7-day window resets, the threshold counters reset too.
- Persist the "already notified" state to disk (alongside the OAuth cache)
  so a logout/login doesn't replay all notifications.
- Optional: DBus signal so other tooling (scripts, status bars on different
  setups) can react to the same events without re-implementing the polling.

## Multi-account support

The indicator shows every config directory listed in `ACCOUNTS` (default `~/.claude` and `~/.claude-private`), one meter and one table column each, with the plan from each credentials file in the column header. What remains is configuring that list without editing `extension.js`, which belongs in the settings UI (Phase 2.5).

## Submit to extensions.gnome.org

To make this installable through the Extensions app or the GNOME Extensions
website, the repo needs:

- Versioned `metadata.json` with a real `url` field (currently set to the
  GitHub repo — good).
- Screenshots (panel button + open dropdown) for the EGO listing.
- A release zip built via `gnome-extensions pack` rather than installed via
  the symlink workflow.
- Submission review by the EGO maintainers — the OAuth-endpoint usage
  may raise a flag (Anthropic's policy posture is grey area, see README).
  Have a clear answer ready: this is a personal-use indicator that reads
  the user's own token from the file Claude Code itself maintains, polls
  at a slower rate than `/usage` does, and degrades gracefully if the
  endpoint disappears.

## Smaller polish

- **Click-to-copy** — add a menu item that copies the current ccusage and
  OAuth numbers to the clipboard for pasting into bug reports.
- **History sparkline** — keep a rolling buffer of recent percentages and
  draw a tiny inline sparkline in the dropdown so trend ("am I climbing or
  flat?") is visible at a glance.

## Things explicitly *not* in scope

- Reverse-engineering the Claude Code binary to call its internal `/usage`
  command non-interactively. The OAuth endpoint is the supported (in spirit
  if not in policy) backdoor; don't pile on more brittleness.
- Polling more aggressively to chase per-second changes. The 5–9 min cadence
  is a deliberate choice for quota-friendliness; tightening it would invite
  the 429 storms documented in the source GitHub issues.
- Cross-distro abstraction. This is GNOME Shell. KDE / Sway / etc. are out of
  scope; a separate project with a shared library would be a better answer
  than feature-flagging across desktop environments here.
