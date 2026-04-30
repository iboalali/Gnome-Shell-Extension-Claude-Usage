# Roadmap

This file tracks work that is **explicitly out of scope** for the shipped
Phase 1 + Phase 2 indicator but is on the table for future iterations.
Order is rough priority, not guaranteed.

## Phase 2.5 — Settings UI (`prefs.js`)

Surface the constants currently hard-coded at the top of `extension.js` in a
GNOME Extensions preferences pane, backed by a GSettings schema.

What to expose:

- ccusage refresh interval (default 60 s).
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

`~/.claude/.credentials.json` holds exactly one identity. If a user has
multiple Claude accounts (personal vs work, etc.) and switches with
`claude logout`/`claude login`, the indicator will pick up the new one
on the next OAuth tick — but there is no way to display both simultaneously.

Possibilities, in order of complexity:

1. **Show the active subscription tier in the menu header** (cheap, no
   multi-account: just expose `subscriptionType` and `rateLimitTier` from
   the credentials file in the dropdown so the user knows which account is
   active).
2. **Multi-instance indicators** — let the user pin multiple top-bar items,
   each tied to a different credentials file path. Requires a settings UI
   first.

(1) is probably enough for most users; (2) is speculative.

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

- **Icon asset** — replace the Unicode emoji indicator (🟢 / 🟡 / ⚪ / ⚠️)
  with a proper themed SVG that respects the system accent colour. Low
  priority; the emoji works fine.
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
