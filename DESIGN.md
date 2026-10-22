# Design

Source: no Claude Design project. The design is recorded from the code and the proposals in `design/proposals/`.
Token values: `stylesheet.css` (colors, sizes) and the `METER_PX` / `BAR_PX` constants in `extension.js`, which must match the track widths in the stylesheet.

## Direction
A quiet, glanceable top-bar item that answers "how close am I to a limit, on which account" without opening anything, and a dropdown that compares accounts side by side. Color carries meaning only: it shows the severity the server assigns, never decoration.

## System
- Type: the shell theme's UI font. Body 15px from the popup theme; column subtitles 8pt; top-bar meter letters 7.5pt bold. Numbers use tabular figures (`font-feature-settings: "tnum"`).
- Color: severity fills `#26a269` (normal), `#e5a50a` (warning), `#e01b24` (critical). Dim text `#8b8a8f`. Tracks `rgba(128,128,128,0.22)` in the menu, `rgba(255,255,255,0.25)` on the dark panel. Dead meter track `rgba(224,27,36,0.55)`.
- Spacing and layout: the dropdown is a table: label column 104px, one 132px column per account, 12px between columns, 8px between rows, 20px side padding.
- Shape and depth: bars 80x8px radius 4 in the menu, top-bar meters 40x4px radius 2. No shadows beyond the shell's popup.
- Motion: none of its own.

## Components
| Component | Code | Design file |
| --- | --- | --- |
| Top-bar meter (one per account) | `ClaudeUsageIndicator._renderTopBar`, `.claude-usage-meter*` | `design/proposals/2026-10-22-second-account-v2.html` (option 5, top bar) |
| Account column header | `_renderTable`, `.claude-usage-col-name`, `.claude-usage-col-sub` | same file, option 3 |
| Limit cell (bar + percentage) | `bar()`, `barCell`, `.claude-usage-bar*`, `.claude-usage-pct` | same file, option 3 |

## Screens
| Screen | Code or route | Design file |
| --- | --- | --- |
| Top bar | `_renderTopBar` | `design/proposals/2026-10-22-second-account-v2.html`, option 5 |
| Dropdown | `_renderTable` | `design/proposals/2026-10-22-second-account-v2.html`, option 3 |

## Rules
- Fill color follows the server's `severity`, not the percentage.
- A top-bar meter shows the account's all-model weekly limit, colored by that limit's severity.
- Stale data fades; dead data empties the meter and says why in the column header. `⚠️ usage` only when every path of every account is dead.
- Alignment comes from fixed CSS widths on St widgets, never from padding text.

## Changes
Newest first.

- 2026-10-22: Top-bar meters show only the all-model weekly limit, colored by that limit's severity. Why: one consistent number per account in the top bar; the session and per-model limits stay in the table.
- 2026-10-22: Second account and restyle. The top bar takes the twin-meter pill from option 5 and the dropdown takes the side-by-side table from option 3, with a `Spend` row added (bar plus the amounts beneath). Replaces the emoji pill and the monospace text rows. Why: show the private account next to the work account, and make the bars line up. Proposal: `design/proposals/2026-10-22-second-account-v2.html`.
