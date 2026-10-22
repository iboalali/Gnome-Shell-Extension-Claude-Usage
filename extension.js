import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const HOME = GLib.get_home_dir();

// ---- accounts ----
// One entry per Claude Code config directory. An account whose directory does
// not exist is skipped. `cacheFile` keeps the first account on the cache name
// older versions wrote, so its warm start survives the upgrade.
const ACCOUNTS = [
    {label: 'Work',    letter: 'W', configDir: GLib.build_filenamev([HOME, '.claude']),
     cacheFile: 'last-oauth.json'},
    {label: 'Private', letter: 'P', configDir: GLib.build_filenamev([HOME, '.claude-private']),
     cacheFile: 'last-oauth-private.json'},
];

// ---- ccusage path (5 min polling) ----
// Each run rescans every transcript of the account, which costs tens of
// CPU-seconds on a large history, so keep this interval long. A tick only runs
// ccusage when a transcript changed since the last run (TRANSCRIPT_CHECK_CMD).
const CCUSAGE_INTERVAL_SEC = 300;
const CCUSAGE = '/usr/local/bin/ccusage';
const CCUSAGE_ARGS = ['blocks', '--active', '--json', '--offline'];
// Prints the first transcript modified after the given unix time, or nothing.
const TRANSCRIPT_CHECK_CMD = (projectsDir, sinceSec) => ['/usr/bin/find', projectsDir,
    '-type', 'f', '-name', '*.jsonl', '-newermt', `@${sinceSec}`, '-print', '-quit'];
const TERMINAL = '/usr/bin/gnome-terminal';

// ---- OAuth path (5-9 min jittered polling, per account) ----
const CACHE_DIR        = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-usage']);
const OAUTH_URL        = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA       = 'oauth-2025-04-20';

const OAUTH_BASE_SEC        = 420;        // 7 min base
const OAUTH_JITTER_SEC      = 120;        // +/-2 min, range 5-9 min
const OAUTH_BACKOFF_MAX_SEC = 1800;       // 30 min ceiling on 429
const OAUTH_STALE_AFTER_MS  = 20 * 60 * 1000;
const OAUTH_DEAD_AFTER_MS   = 2 * 60 * 60 * 1000;
const OAUTH_DEAD_MAX_FAILS  = 6;

// ---- layout ----
// Widths are in CSS pixels, matching the track widths in stylesheet.css, so a
// fill's share of its track is exact.
const METER_PX = 40;
const BAR_PX   = 80;

// ---- formatters ----
function fmtTokens(n) {
    if (n == null) return '—';
    if (n < 1000) return String(Math.round(n));
    if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k';
    return (n / 1_000_000).toFixed(2) + 'M';
}

function fmtMins(m) {
    if (m == null || m < 0) return '—';
    if (m < 60) return `${Math.round(m)}m`;
    const h = Math.floor(m / 60);
    const mm = Math.round(m % 60);
    return `${h}h${String(mm).padStart(2, '0')}m`;
}

function fmtPct(n) {
    if (n == null) return '—';
    return `${Math.round(n)}%`;
}

function fmtUntilIso(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '—';
    const diffMin = (t - Date.now()) / 60_000;
    if (diffMin < 0) return 'now';
    if (diffMin < 60) return `${Math.round(diffMin)}m`;
    const h = Math.floor(diffMin / 60);
    const m = Math.round(diffMin % 60);
    if (h < 24) return `${h}h${String(m).padStart(2, '0')}m`;
    const d = Math.floor(h / 24);
    return `${d}d${h % 24}h`;
}

// Local weekday and wall-clock for a reset timestamp, e.g. "Sat 16:59".
// Locale-aware via GLib (honors LC_TIME); a weekly reset is never more than
// seven days out, so the weekday is unambiguous.
function fmtWeekdayIso(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '—';
    const dt = GLib.DateTime.new_from_unix_local(Math.floor(t / 1000));
    return dt ? dt.format('%a %H:%M') : '—';
}

function fmtAgo(ms) {
    if (ms == null || ms < 0) return 'just now';
    const m = Math.floor(ms / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h${m % 60}m ago`;
    return `${Math.floor(h / 24)}d ago`;
}

// "team" + "default_claude_max_5x" -> "Team · Max 5x"; "pro" -> "Pro".
function fmtPlan(subscriptionType, rateLimitTier) {
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    const tier = /max_(\d+x)/.exec(rateLimitTier ?? '')?.[1];
    if (!subscriptionType) return tier ? `Max ${tier}` : '';
    if (subscriptionType === 'max') return tier ? `Max ${tier}` : 'Max';
    return tier ? `${cap(subscriptionType)} · Max ${tier}` : cap(subscriptionType);
}

// ---- limits[] : per-model quotas and server-side severity ----
// The payload carries a `limits` array alongside the `five_hour`/`seven_day`
// buckets. Entries of kind `weekly_scoped` are quotas that apply to one model
// only (`scope.model.display_name`), and they can sit at 99% while the
// all-model weekly number is still comfortable. Every entry also carries a
// `severity` the server assigns, which is the only signal that says a limit
// matters right now.
const SEV_NORMAL   = 0;
const SEV_WARNING  = 1;
const SEV_CRITICAL = 2;
const SEVERITY_RANK = {normal: SEV_NORMAL, warning: SEV_WARNING, critical: SEV_CRITICAL};
const SEVERITY_CLASS = ['normal', 'warning', 'critical'];

function severityRank(severity) {
    if (!severity || severity === 'normal') return SEV_NORMAL;
    // An unrecognized severity still means the server flagged something, so it
    // counts as a warning instead of being dropped on the floor.
    return SEVERITY_RANK[severity] ?? SEV_WARNING;
}

function limitsOf(data) {
    return Array.isArray(data?.limits) ? data.limits : [];
}

function limitOfKind(data, kind) {
    return limitsOf(data).find(l => l?.kind === kind) ?? null;
}

function scopedWeeklyLimits(data) {
    return limitsOf(data).filter(l => l?.kind === 'weekly_scoped' && l?.scope?.model?.display_name);
}

// ---- spend : the monthly extra-usage cap ----
// Money spent past the plan limits. Amounts arrive as integer minor units plus
// an exponent, so 2000 with exponent 2 is 20.00. Accounts without the cap carry
// no `spend` object at all.
const CURRENCY_SYMBOL = {EUR: '€', USD: '$', GBP: '£', JPY: '¥'};

function fmtMoney(money) {
    if (!money || !Number.isFinite(money.amount_minor)) return '—';
    const exponent = Number.isFinite(money.exponent) ? money.exponent : 2;
    const amount = (money.amount_minor / 10 ** exponent).toFixed(exponent);
    const symbol = CURRENCY_SYMBOL[money.currency];
    return symbol ? `${symbol}${amount}` : `${amount} ${money.currency ?? ''}`.trim();
}

function logTag(msg) {
    log(`[claude-usage] ${msg}`);
}

// ---- one account: its OAuth path and its ccusage path ----
// The two paths keep separate timers, cancellables and state. `onChange` is
// called after either path updates; only the indicator's _render() combines
// them.
class Account {
    constructor(def, soup, onChange) {
        this.label = def.label;
        this.letter = def.letter;
        this._configDir = def.configDir;
        this._credsPath = GLib.build_filenamev([def.configDir, '.credentials.json']);
        this._projectsDir = GLib.build_filenamev([def.configDir, 'projects']);
        this._cacheFile = GLib.build_filenamev([CACHE_DIR, def.cacheFile]);
        this._soup = soup;
        this._onChange = onChange;

        this.plan = '';
        this.oauth = null;
        this.oauthError = null;
        this._oauthFailStreak = 0;
        this._oauthInterval = OAUTH_BASE_SEC;
        this._lastTokenSeen = null;
        this._oauthTimerId = 0;
        this._oauthCancellable = null;

        this.ccusage = null;
        this.ccusageError = null;
        this._ccusageTimerId = 0;
        this._ccusageCancellable = null;
        this._ccusageProc = null;
        this._ccusageRunStartSec = null;
    }

    start() {
        this._readCredentials();
        this._loadOauthCacheSync();
        this.refreshCcusage();
        this._ccusageTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CCUSAGE_INTERVAL_SEC, () => {
            this.refreshCcusage();
            return GLib.SOURCE_CONTINUE;
        });
        this._scheduleOauthTick(0);
    }

    _log(msg) {
        logTag(`${this.label}: ${msg}`);
    }

    // ---------- ccusage ----------

    refreshCcusage(force = false) {
        // A run already in flight returns fresh data soon; starting another
        // would scan the whole transcript history twice in parallel.
        if (this._ccusageProc) return;

        const block = this.activeBlock();
        const blockEnded = block && Date.parse(block.endTime) <= Date.now();
        if (force || this.ccusageError || !this.ccusage || blockEnded ||
            this._ccusageRunStartSec == null) {
            this._runCcusage();
            return;
        }

        // One second of slack covers transcript writes in the same second the
        // last run started.
        const argv = TRANSCRIPT_CHECK_CMD(this._projectsDir, this._ccusageRunStartSec - 1);
        this._spawnCcusageStep(argv, (p, stdout) => {
            // A failed check (e.g. no projects directory yet) falls back to a real run.
            if (!p.get_successful() || stdout.trim() !== '') this._runCcusage();
        });
    }

    _runCcusage() {
        this._ccusageRunStartSec = Math.floor(Date.now() / 1000);
        this._spawnCcusageStep([CCUSAGE, ...CCUSAGE_ARGS], (p, stdout) => {
            if (!p.get_successful()) {
                this.ccusageError = 'ccusage exited non-zero';
                this.ccusage = null;
            } else {
                this.ccusage = JSON.parse(stdout);
                this.ccusageError = null;
            }
        });
    }

    // Runs one subprocess of the ccusage path through _ccusageProc and
    // _ccusageCancellable, so destroy() releases it like any other run.
    // CLAUDE_CONFIG_DIR points ccusage at this account's transcripts only.
    _spawnCcusageStep(argv, onDone) {
        this._ccusageCancellable = new Gio.Cancellable();

        let proc;
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            launcher.setenv('CLAUDE_CONFIG_DIR', this._configDir, true);
            proc = launcher.spawnv(argv);
        } catch (e) {
            this.ccusageError = `spawn: ${e.message}`;
            this.ccusage = null;
            this._onChange();
            return;
        }
        this._ccusageProc = proc;

        proc.communicate_utf8_async(null, this._ccusageCancellable, (p, res) => {
            if (this._ccusageProc === p) this._ccusageProc = null;
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                onDone(p, stdout ?? '');
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
                this.ccusageError = `parse: ${e.message}`;
                this.ccusage = null;
            }
            this._onChange();
        });
    }

    activeBlock() {
        const blocks = this.ccusage?.blocks || [];
        return blocks.find(b => b.isActive) || null;
    }

    classifyCcusage() {
        if (this.ccusageError || !this.ccusage) return 'dead';
        return this.activeBlock() ? 'fresh' : 'idle';
    }

    // ---------- OAuth ----------

    _scheduleOauthTick(overrideDelay) {
        if (this._oauthTimerId) {
            GLib.source_remove(this._oauthTimerId);
            this._oauthTimerId = 0;
        }
        let delay;
        if (overrideDelay != null) {
            delay = overrideDelay;
        } else {
            const base = this._oauthInterval;
            const jitter = (Math.random() * 2 - 1) * OAUTH_JITTER_SEC;
            delay = Math.max(60, Math.min(OAUTH_BACKOFF_MAX_SEC, Math.round(base + jitter)));
        }
        this._log(`next OAuth tick in ${delay}s`);
        this._oauthTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._oauthTimerId = 0;
            this._refreshOauth();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Returns the access token and refreshes `plan` from the same file.
    _readCredentials() {
        try {
            const file = Gio.File.new_for_path(this._credsPath);
            const [ok, contents] = file.load_contents(null);
            if (!ok) return null;
            const oauth = JSON.parse(new TextDecoder().decode(contents))?.claudeAiOauth;
            this.plan = fmtPlan(oauth?.subscriptionType, oauth?.rateLimitTier);
            return oauth?.accessToken ?? null;
        } catch (e) {
            this._log(`token read failed: ${e.message}`);
            return null;
        }
    }

    _refreshOauth() {
        const token = this._readCredentials();
        if (!token) {
            this._oauthFailStreak++;
            this.oauthError = {code: 0, message: 'no token in credentials file', at: Date.now()};
            this._onChange();
            this._scheduleOauthTick();
            return;
        }
        const sameToken = token === this._lastTokenSeen;
        this._lastTokenSeen = token;

        if (this._oauthCancellable) this._oauthCancellable.cancel();
        this._oauthCancellable = new Gio.Cancellable();

        const msg = Soup.Message.new('GET', OAUTH_URL);
        const headers = msg.get_request_headers();
        headers.append('Authorization', `Bearer ${token}`);
        headers.append('anthropic-beta', OAUTH_BETA);
        headers.append('Content-Type', 'application/json');

        this._soup.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._oauthCancellable, (sess, res) => {
            let bytes;
            try {
                bytes = sess.send_and_read_finish(res);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
                this._oauthFailStreak++;
                this.oauthError = {code: 0, message: e.message, at: Date.now()};
                this._log(`OAuth network error: ${e.message}`);
                this._onChange();
                this._scheduleOauthTick();
                return;
            }

            const status = msg.get_status();
            const body = bytes ? new TextDecoder().decode(bytes.get_data() || new Uint8Array()) : '';

            if (status === 200) {
                try {
                    const data = JSON.parse(body);
                    this.oauth = {...data, fetchedAt: Date.now()};
                    this.oauthError = null;
                    this._oauthFailStreak = 0;
                    this._oauthInterval = OAUTH_BASE_SEC;
                    this._writeOauthCache(this.oauth);
                    const scoped = scopedWeeklyLimits(data)
                        .map(l => ` ${l.scope.model.display_name}=${l.percent}`).join('');
                    this._log(`OAuth ok: 5h=${data?.five_hour?.utilization} 7d=${data?.seven_day?.utilization}${scoped}`);
                } catch (e) {
                    this._oauthFailStreak++;
                    this.oauthError = {code: 200, message: `parse: ${e.message}`, at: Date.now()};
                    this._log(`OAuth parse error: ${e.message}`);
                }
            } else if (status === 429) {
                this._oauthFailStreak++;
                this.oauthError = {code: 429, message: 'rate limited (429)', at: Date.now()};
                this._oauthInterval = Math.min(OAUTH_BACKOFF_MAX_SEC, this._oauthInterval * 2);
                this._log(`OAuth 429; backoff -> ${this._oauthInterval}s`);
            } else if (status === 401) {
                this._log(`OAuth 401${sameToken ? ' (same token)' : ' (new token)'}`);
                if (!sameToken) {
                    this._onChange();
                    this._scheduleOauthTick(0);
                    return;
                }
                this._oauthFailStreak++;
                this.oauthError = {code: 401, message: 'unauthorized (401)', at: Date.now()};
                this._oauthInterval = Math.min(OAUTH_BACKOFF_MAX_SEC, this._oauthInterval * 2);
            } else {
                this._oauthFailStreak++;
                this.oauthError = {code: status, message: `HTTP ${status}`, at: Date.now()};
                this._log(`OAuth HTTP ${status}: ${body.slice(0, 200)}`);
            }
            this._onChange();
            this._scheduleOauthTick();
        });
    }

    _loadOauthCacheSync() {
        try {
            const file = Gio.File.new_for_path(this._cacheFile);
            if (!file.query_exists(null)) return;
            const [ok, contents] = file.load_contents(null);
            if (!ok) return;
            const data = JSON.parse(new TextDecoder().decode(contents));
            if (data && typeof data.fetchedAt === 'number') {
                this.oauth = data;
                this._log(`warm-start cache age=${Math.round((Date.now() - data.fetchedAt) / 1000)}s`);
            }
        } catch (e) {
            this._log(`cache load failed: ${e.message}`);
        }
    }

    _writeOauthCache(data) {
        try {
            GLib.mkdir_with_parents(CACHE_DIR, 0o700);
            const file = Gio.File.new_for_path(this._cacheFile);
            const bytes = new TextEncoder().encode(JSON.stringify(data));
            file.replace_contents(
                bytes, null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (e) {
            this._log(`cache write failed: ${e.message}`);
        }
    }

    classifyOauth() {
        if (!this.oauth) return 'dead';
        if (this._oauthFailStreak >= OAUTH_DEAD_MAX_FAILS) return 'dead';
        const age = Date.now() - this.oauth.fetchedAt;
        if (age >= OAUTH_DEAD_AFTER_MS) return 'dead';
        if (age >= OAUTH_STALE_AFTER_MS) return 'stale';
        return 'fresh';
    }

    // The all-model weekly limit, which the top-bar meter shows.
    weekly() {
        return {
            pct: this.oauth?.seven_day?.utilization ?? 0,
            rank: severityRank(limitOfKind(this.oauth, 'weekly_all')?.severity),
        };
    }

    terminalScript() {
        const header = `echo; echo '== ${this.label} =='`;
        return `${header}; CLAUDE_CONFIG_DIR=${GLib.shell_quote(this._configDir)} ${CCUSAGE} blocks --recent --offline`;
    }

    destroy() {
        if (this._ccusageTimerId) {
            GLib.source_remove(this._ccusageTimerId);
            this._ccusageTimerId = 0;
        }
        if (this._oauthTimerId) {
            GLib.source_remove(this._oauthTimerId);
            this._oauthTimerId = 0;
        }
        if (this._ccusageCancellable) {
            this._ccusageCancellable.cancel();
            this._ccusageCancellable = null;
        }
        if (this._ccusageProc) {
            this._ccusageProc.force_exit();
            this._ccusageProc = null;
        }
        if (this._oauthCancellable) {
            this._oauthCancellable.cancel();
            this._oauthCancellable = null;
        }
    }
}

// ---- widgets ----

// A track with a fill whose width is the given share of `trackPx`. Non-zero
// values get at least 2px so a 1% limit is still visible.
function bar(pct, rank, trackClass, fillClass, trackPx) {
    const track = new St.Widget({
        style_class: trackClass,
        y_align: Clutter.ActorAlign.CENTER,
        layout_manager: new Clutter.BinLayout(),
    });
    const clamped = Math.max(0, Math.min(100, pct ?? 0));
    const px = clamped > 0 ? Math.max(2, Math.round(clamped / 100 * trackPx)) : 0;
    const fill = new St.Widget({
        style_class: `${fillClass} claude-usage-sev-${SEVERITY_CLASS[rank]}`,
        style: `width: ${px}px;`,
        x_align: Clutter.ActorAlign.START,
        x_expand: true,
    });
    track.add_child(fill);
    return {track, fill};
}

function label(text, styleClass) {
    return new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
}

// A plain class around a PanelMenu.Button rather than a GObject subclass, so
// loading the module again in the same Shell registers no second GType.
class ClaudeUsageIndicator {
    constructor() {
        this.button = new PanelMenu.Button(0.0, 'Claude Usage');
        this.menu = this.button.menu;

        this._soup = new Soup.Session({user_agent: 'claude-usage-gnome/0.2'});
        this._accounts = ACCOUNTS
            .filter(def => GLib.file_test(def.configDir, GLib.FileTest.IS_DIR))
            .map(def => new Account(def, this._soup, () => this._render()));

        // Top bar: one meter per account, then the active block.
        this._pill = new St.BoxLayout({style_class: 'claude-usage-pill', y_align: Clutter.ActorAlign.CENTER});
        this._meters = new St.BoxLayout({
            style_class: 'claude-usage-meters', vertical: true, y_align: Clutter.ActorAlign.CENTER,
        });
        this._blockLetter = label('', 'claude-usage-block-letter');
        this._blockLabel = label('… loading', 'claude-usage-label');
        this._pill.add_child(this._meters);
        this._pill.add_child(this._blockLetter);
        this._pill.add_child(this._blockLabel);
        this.button.add_child(this._pill);

        // Dropdown: one column per account, rebuilt on every render.
        this._table = new St.BoxLayout({style_class: 'claude-usage-table', vertical: true});
        const tableSection = new PopupMenu.PopupMenuSection();
        tableSection.actor.add_child(this._table);
        this.menu.addMenuItem(tableSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const openTermItem = new PopupMenu.PopupMenuItem('Open ccusage in terminal');
        openTermItem.connect('activate', () => this._openInTerminal());
        this.menu.addMenuItem(openTermItem);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this._refresh());
        this.menu.addMenuItem(refreshItem);

        // Refresh ccusage on menu open, but NOT OAuth (don't burn quota on click).
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) this._accounts.forEach(a => a.refreshCcusage());
        });

        this._render();
        this._accounts.forEach(a => a.start());
    }

    _refresh() {
        // User-triggered "Refresh now": only the cheap path.
        this._accounts.forEach(a => a.refreshCcusage(true));
    }

    // ---------- render ----------

    _render() {
        this._renderTopBar();
        this._renderTable();
    }

    _renderTopBar() {
        this._meters.destroy_all_children();
        const states = this._accounts.map(a => ({oauth: a.classifyOauth(), cc: a.classifyCcusage()}));
        const allDead = states.every(s => s.oauth === 'dead' && s.cc === 'dead');

        this._meters.visible = !allDead && this._accounts.length > 0;
        this._accounts.forEach((account, i) => {
            const row = new St.BoxLayout({style_class: 'claude-usage-meter-row'});
            row.add_child(label(account.letter, 'claude-usage-meter-letter'));
            const oauthState = states[i].oauth;
            const {pct, rank} = account.weekly();
            const shown = oauthState === 'dead' ? 0 : pct;
            const {track, fill} = bar(shown, rank, 'claude-usage-meter', 'claude-usage-meter-fill', METER_PX);
            if (oauthState === 'dead') track.add_style_class_name('claude-usage-meter-dead');
            // Stale data still shows, faded, so the bar never claims to be current.
            if (oauthState === 'stale') fill.opacity = 110;
            row.add_child(track);
            this._meters.add_child(row);
        });

        if (allDead) {
            this._blockLetter.visible = false;
            this._blockLabel.visible = true;
            this._blockLabel.set_text('⚠️ usage');
            return;
        }

        // The active block whose last activity is most recent: the account in use.
        let current = null;
        for (const account of this._accounts) {
            const block = account.activeBlock();
            if (!block) continue;
            const last = Date.parse(block.actualEndTime ?? block.startTime);
            if (!current || last > current.last) current = {account, block, last};
        }
        this._blockLetter.visible = !!current && this._accounts.length > 1;
        this._blockLabel.visible = !!current;
        if (current) {
            const {account, block} = current;
            this._blockLetter.set_text(account.letter);
            const ends = block.endTime ? fmtUntilIso(block.endTime) : fmtMins(block.projection?.remainingMinutes);
            this._blockLabel.set_text(`${fmtTokens(block.totalTokens ?? 0)} · ${ends}`);
        }
    }

    _renderTable() {
        this._table.destroy_all_children();
        const accounts = this._accounts;
        const oauthStates = accounts.map(a => a.classifyOauth());
        const ccStates = accounts.map(a => a.classifyCcusage());

        const addRow = (labelText, cells, extraClass = '') => {
            const row = new St.BoxLayout({style_class: `claude-usage-row ${extraClass}`});
            row.add_child(label(labelText, 'claude-usage-row-label'));
            cells.forEach(cell => row.add_child(cell));
            this._table.add_child(row);
        };
        const textCell = (text, styleClass = 'claude-usage-value') => {
            const cell = new St.BoxLayout({style_class: 'claude-usage-cell'});
            cell.add_child(label(text, styleClass));
            return cell;
        };
        const dimCell = text => textCell(text, 'claude-usage-dim');
        const barCell = (i, pct, rank) => {
            if (pct == null) return dimCell('—');
            const cell = new St.BoxLayout({style_class: 'claude-usage-cell'});
            const {track, fill} = bar(pct, rank, 'claude-usage-bar', 'claude-usage-bar-fill', BAR_PX);
            if (oauthStates[i] !== 'fresh') fill.opacity = 110;
            cell.add_child(track);
            cell.add_child(label(fmtPct(pct), 'claude-usage-pct'));
            return cell;
        };
        // OAuth values of account i, or null when there is nothing to show.
        const oauthOf = i => accounts[i].oauth;

        // ---- column headers ----
        const headCells = accounts.map((account, i) => {
            const col = new St.BoxLayout({style_class: 'claude-usage-cell', vertical: true});
            col.add_child(label(account.label, 'claude-usage-col-name'));
            let sub = account.plan;
            if (oauthStates[i] === 'dead') {
                sub = account.oauthError?.message ?? 'no data';
                if (account.oauth) sub += `, ${fmtAgo(Date.now() - account.oauth.fetchedAt)}`;
            } else if (oauthStates[i] === 'stale') {
                sub = `updated ${fmtAgo(Date.now() - account.oauth.fetchedAt)}`;
            }
            col.add_child(label(sub || ' ', 'claude-usage-col-sub'));
            return col;
        });
        addRow('', headCells, 'claude-usage-head');

        // ---- limits ----
        addRow('Session', accounts.map((_, i) => barCell(i,
            oauthOf(i)?.five_hour?.utilization,
            severityRank(limitOfKind(oauthOf(i), 'session')?.severity))));
        addRow('Week', accounts.map((_, i) => barCell(i,
            oauthOf(i)?.seven_day?.utilization,
            severityRank(limitOfKind(oauthOf(i), 'weekly_all')?.severity))));

        // One row per model that has its own weekly quota on any account.
        const models = [...new Set(accounts.flatMap(a =>
            scopedWeeklyLimits(a.oauth).map(l => l.scope.model.display_name)))];
        for (const model of models) {
            addRow(`${model} week`, accounts.map((a, i) => {
                const limit = scopedWeeklyLimits(a.oauth).find(l => l.scope.model.display_name === model);
                return limit ? barCell(i, limit.percent, severityRank(limit.severity)) : dimCell('—');
            }));
        }

        // Monthly spend: share of the cap, then the amounts beneath.
        if (accounts.some(a => a.oauth?.spend)) {
            addRow('Spend', accounts.map((a, i) => {
                const spend = a.oauth?.spend;
                if (!spend) return dimCell('—');
                if (spend.enabled === false) return dimCell('off');
                return barCell(i, spend.percent ?? 0, severityRank(spend.severity));
            }));
            addRow('', accounts.map(a => {
                const spend = a.oauth?.spend;
                if (!spend || spend.enabled === false) return dimCell(spend?.disabled_reason ?? '');
                return dimCell(`${fmtMoney(spend.used)} of ${fmtMoney(spend.limit ?? spend.cap?.money)}`);
            }), 'claude-usage-subrow');
        }

        addRow('Session resets', accounts.map(a => {
            if (!a.oauth) return dimCell('—');
            const resetsAt = a.oauth.five_hour?.resets_at;
            return resetsAt ? textCell(fmtUntilIso(resetsAt)) : dimCell('not started');
        }));
        addRow('Week resets', accounts.map(a => textCell(fmtWeekdayIso(a.oauth?.seven_day?.resets_at))));

        this._table.add_child(new St.Widget({style_class: 'claude-usage-divider'}));

        // ---- ccusage ----
        const ccCell = (i, render) => {
            if (ccStates[i] === 'dead') return dimCell(accounts[i].ccusageError ?? 'no data');
            if (ccStates[i] === 'idle') return dimCell('—');
            return textCell(render(accounts[i].activeBlock()));
        };
        addRow('Tokens', accounts.map((_, i) => ccStates[i] === 'idle'
            ? dimCell('no active block')
            : ccCell(i, b => fmtTokens(b.totalTokens ?? 0))));
        addRow('Burn', accounts.map((_, i) => ccCell(i, b => `${fmtTokens(b.burnRate?.tokensPerMinute)} / min`)));
        addRow('Ends in', accounts.map((_, i) => ccCell(i, b =>
            b.endTime ? fmtUntilIso(b.endTime) : fmtMins(b.projection?.remainingMinutes))));
    }

    _openInTerminal() {
        const script = this._accounts.map(a => a.terminalScript()).join('; ');
        try {
            Gio.Subprocess.new([TERMINAL, '--', 'bash', '-c',
                `${script}; echo; read -n1 -r -p 'Press any key to close…'`], Gio.SubprocessFlags.NONE);
        } catch (e) {
            Main.notify('Claude Usage', `Could not open terminal: ${e.message}`);
        }
    }

    destroy() {
        this._accounts.forEach(a => a.destroy());
        this._accounts = [];
        if (this._soup) {
            this._soup.abort();
            this._soup = null;
        }
        this.button.destroy();
    }
}

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._indicator = new ClaudeUsageIndicator();
        Main.panel.addToStatusArea('claude-usage', this._indicator.button);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
