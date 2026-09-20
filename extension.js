import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// ---- ccusage path (60s polling) ----
const CCUSAGE_INTERVAL_SEC = 60;
const CCUSAGE = '/usr/local/bin/ccusage';
const CCUSAGE_ARGS = ['blocks', '--active', '--json', '--offline'];
const TERMINAL_CMD = ['/usr/bin/gnome-terminal', '--', 'bash', '-c',
    `${CCUSAGE} blocks --recent --offline; echo; read -n1 -r -p 'Press any key to close…'`];

// ---- OAuth path (5–9 min jittered polling) ----
const CREDS_PATH       = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
const CACHE_DIR        = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-usage']);
const CACHE_FILE       = GLib.build_filenamev([CACHE_DIR, 'last-oauth.json']);
const OAUTH_URL        = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA       = 'oauth-2025-04-20';

const OAUTH_BASE_SEC        = 420;        // 7 min base
const OAUTH_JITTER_SEC      = 120;        // ±2 min, range 5–9 min
const OAUTH_BACKOFF_MAX_SEC = 1800;       // 30 min ceiling on 429
const OAUTH_STALE_AFTER_MS  = 20 * 60 * 1000;
const OAUTH_DEAD_AFTER_MS   = 2 * 60 * 60 * 1000;
const OAUTH_DEAD_MAX_FAILS  = 6;

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

function fmtUSD(n) {
    if (n == null) return '—';
    return '$' + n.toFixed(2);
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

// Absolute local wall-clock for a reset timestamp, e.g. "Sat 27 Jun 16:59".
// Locale-aware via GLib (honours LC_TIME); returns null when unparseable.
function fmtAbsIso(iso) {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    const dt = GLib.DateTime.new_from_unix_local(Math.floor(t / 1000));
    if (!dt) return null;
    return dt.format('%a %d %b %H:%M');
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

const BAR_WIDTH = 10;
const BAR_PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

function fmtBar(pct) {
    if (pct == null || !Number.isFinite(pct)) return '[' + '░'.repeat(BAR_WIDTH) + ']';
    const clamped = Math.max(0, Math.min(100, pct));
    const eighths = Math.round((clamped / 100) * BAR_WIDTH * 8);
    const full = Math.floor(eighths / 8);
    const partial = eighths % 8;
    let bar = '█'.repeat(full);
    if (partial > 0) bar += BAR_PARTIAL[partial];
    bar += '░'.repeat(BAR_WIDTH - full - (partial > 0 ? 1 : 0));
    return `[${bar}]`;
}

const LABEL_WIDTH = 14;
function kv(label, value) {
    return label.padEnd(LABEL_WIDTH) + value;
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

function severityRank(severity) {
    if (!severity || severity === 'normal') return SEV_NORMAL;
    // An unrecognized severity still means the server flagged something, so it
    // counts as a warning instead of being dropped on the floor.
    return SEVERITY_RANK[severity] ?? SEV_WARNING;
}

// Per-model weekly limits, worst first, so the row that needs attention is the
// one nearest the all-model week row.
function scopedWeeklyLimits(data) {
    const limits = Array.isArray(data?.limits) ? data.limits : [];
    return limits
        .filter(l => l?.kind === 'weekly_scoped' && l?.scope?.model?.display_name)
        .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0));
}

// Model names have to fit the same padded column as "Session (5h):", leaving
// one space before the value. Longer names are truncated rather than allowed to
// push the bars out of alignment.
const SCOPED_SUFFIX = ' (7d):';
const SCOPED_NAME_MAX = LABEL_WIDTH - 1 - SCOPED_SUFFIX.length;

function scopedLabel(name) {
    const short = name.length > SCOPED_NAME_MAX
        ? name.slice(0, SCOPED_NAME_MAX - 1) + '…'
        : name;
    return short + SCOPED_SUFFIX;
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

const ClaudeUsageIndicator = GObject.registerClass(
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Claude Usage');

        this._label = new St.Label({
            text: '… loading',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-label',
        });
        this.add_child(this._label);

        // OAuth percentages on top — they're the more important number.
        // Each pct row gets a dedicated sub-row beneath it for the absolute
        // reset wall-clock (a single St.Label won't render a second line here).
        this._sessionItem      = new PopupMenu.PopupMenuItem('Session (5h):', {reactive: false});
        this._sessionResetItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._weekItem         = new PopupMenu.PopupMenuItem('Week (7d):',    {reactive: false});
        this._weekResetItem    = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._sessionItem);
        this.menu.addMenuItem(this._sessionResetItem);
        this.menu.addMenuItem(this._weekItem);
        this.menu.addMenuItem(this._weekResetItem);

        // Per-model weekly rows sit under the all-model week row. How many
        // there are depends on the account, so they live in a section with a
        // pool of rows that grows on demand and hides what it doesn't need.
        this._scopedSection = new PopupMenu.PopupMenuSection();
        this._scopedRows = [];
        this.menu.addMenuItem(this._scopedSection);

        // A monthly money cap, not a quota that resets on a clock, so this row
        // gets no absolute-reset sub-row.
        this._spendItem = new PopupMenu.PopupMenuItem('Spend (mo):', {reactive: false});
        this.menu.addMenuItem(this._spendItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ccusage rows
        this._tokensItem = new PopupMenu.PopupMenuItem('Tokens:',  {reactive: false});
        this._burnItem   = new PopupMenu.PopupMenuItem('Burn:',    {reactive: false});
        this._costItem   = new PopupMenu.PopupMenuItem('Cost:',    {reactive: false});
        this._endsItem   = new PopupMenu.PopupMenuItem('Ends in:', {reactive: false});
        this.menu.addMenuItem(this._tokensItem);
        this.menu.addMenuItem(this._burnItem);
        this.menu.addMenuItem(this._costItem);
        this.menu.addMenuItem(this._endsItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Monospace the inner labels so the progress bar and column labels line up.
        for (const item of [this._sessionItem, this._sessionResetItem,
                            this._weekItem, this._weekResetItem,
                            this._spendItem,
                            this._tokensItem, this._burnItem,
                            this._costItem, this._endsItem]) {
            item.label.add_style_class_name('claude-usage-mono');
        }

        const openTermItem = new PopupMenu.PopupMenuItem('Open ccusage in terminal');
        openTermItem.connect('activate', () => this._openInTerminal());
        this.menu.addMenuItem(openTermItem);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this._refresh());
        this.menu.addMenuItem(refreshItem);

        // Refresh ccusage on menu open — but NOT OAuth (don't burn quota on click).
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) this._refreshCcusage();
        });

        // state
        this._ccusageData = null;
        this._ccusageError = null;
        this._lastOauth = null;
        this._lastOauthError = null;
        this._oauthFailStreak = 0;
        this._oauthInterval = OAUTH_BASE_SEC;
        this._lastTokenSeen = null;

        this._ccusageTimerId = 0;
        this._oauthTimerId = 0;
        this._ccusageCancellable = null;
        this._oauthCancellable = null;

        this._soup = new Soup.Session({user_agent: 'claude-usage-gnome/0.2'});

        this._loadOauthCacheSync();
        this._render();
        this._refreshCcusage();
        this._startCcusageTimer();
        this._scheduleOauthTick(0);
    }

    // ---------- ccusage ----------

    _startCcusageTimer() {
        this._ccusageTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CCUSAGE_INTERVAL_SEC, () => {
            this._refreshCcusage();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _refresh() {
        // User-triggered "Refresh now" — only the cheap path.
        this._refreshCcusage();
    }

    _refreshCcusage() {
        if (this._ccusageCancellable) this._ccusageCancellable.cancel();
        this._ccusageCancellable = new Gio.Cancellable();

        let proc;
        try {
            proc = Gio.Subprocess.new(
                [CCUSAGE, ...CCUSAGE_ARGS],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
        } catch (e) {
            this._ccusageError = `spawn: ${e.message}`;
            this._ccusageData = null;
            this._render();
            return;
        }

        proc.communicate_utf8_async(null, this._ccusageCancellable, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                if (!p.get_successful()) {
                    this._ccusageError = 'ccusage exited non-zero';
                    this._ccusageData = null;
                } else {
                    this._ccusageData = JSON.parse(stdout);
                    this._ccusageError = null;
                }
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
                this._ccusageError = `parse: ${e.message}`;
                this._ccusageData = null;
            }
            this._render();
        });
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
        logTag(`next OAuth tick in ${delay}s`);
        this._oauthTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._oauthTimerId = 0;
            this._refreshOauth();
            return GLib.SOURCE_REMOVE;
        });
    }

    _readToken() {
        try {
            const file = Gio.File.new_for_path(CREDS_PATH);
            const [ok, contents] = file.load_contents(null);
            if (!ok) return null;
            const text = new TextDecoder().decode(contents);
            const json = JSON.parse(text);
            return json?.claudeAiOauth?.accessToken ?? null;
        } catch (e) {
            logTag(`token read failed: ${e.message}`);
            return null;
        }
    }

    _refreshOauth() {
        const token = this._readToken();
        if (!token) {
            this._oauthFailStreak++;
            this._lastOauthError = {code: 0, message: 'no token in credentials file', at: Date.now()};
            this._render();
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
                this._lastOauthError = {code: 0, message: e.message, at: Date.now()};
                logTag(`OAuth network error: ${e.message}`);
                this._render();
                this._scheduleOauthTick();
                return;
            }

            const status = msg.get_status();
            const body = bytes ? new TextDecoder().decode(bytes.get_data() || new Uint8Array()) : '';

            if (status === 200) {
                try {
                    const data = JSON.parse(body);
                    this._lastOauth = {...data, fetchedAt: Date.now()};
                    this._lastOauthError = null;
                    this._oauthFailStreak = 0;
                    this._oauthInterval = OAUTH_BASE_SEC;
                    this._writeOauthCache(this._lastOauth);
                    const scoped = scopedWeeklyLimits(data)
                        .map(l => ` ${l.scope.model.display_name}=${l.percent}`).join('');
                    logTag(`OAuth ok: 5h=${data?.five_hour?.utilization} 7d=${data?.seven_day?.utilization}${scoped}`);
                } catch (e) {
                    this._oauthFailStreak++;
                    this._lastOauthError = {code: 200, message: `parse: ${e.message}`, at: Date.now()};
                    logTag(`OAuth parse error: ${e.message}`);
                }
            } else if (status === 429) {
                this._oauthFailStreak++;
                this._lastOauthError = {code: 429, message: 'rate limited (429)', at: Date.now()};
                this._oauthInterval = Math.min(OAUTH_BACKOFF_MAX_SEC, this._oauthInterval * 2);
                logTag(`OAuth 429; backoff -> ${this._oauthInterval}s`);
            } else if (status === 401) {
                logTag(`OAuth 401${sameToken ? ' (same token)' : ' (new token)'}`);
                if (!sameToken) {
                    this._render();
                    this._scheduleOauthTick(0);
                    return;
                }
                this._oauthFailStreak++;
                this._lastOauthError = {code: 401, message: 'unauthorized (401)', at: Date.now()};
                this._oauthInterval = Math.min(OAUTH_BACKOFF_MAX_SEC, this._oauthInterval * 2);
            } else {
                this._oauthFailStreak++;
                this._lastOauthError = {code: status, message: `HTTP ${status}`, at: Date.now()};
                logTag(`OAuth HTTP ${status}: ${body.slice(0, 200)}`);
            }
            this._render();
            this._scheduleOauthTick();
        });
    }

    _loadOauthCacheSync() {
        try {
            const file = Gio.File.new_for_path(CACHE_FILE);
            if (!file.query_exists(null)) return;
            const [ok, contents] = file.load_contents(null);
            if (!ok) return;
            const text = new TextDecoder().decode(contents);
            const data = JSON.parse(text);
            if (data && typeof data.fetchedAt === 'number') {
                this._lastOauth = data;
                logTag(`warm-start cache age=${Math.round((Date.now() - data.fetchedAt) / 1000)}s`);
            }
        } catch (e) {
            logTag(`cache load failed: ${e.message}`);
        }
    }

    _writeOauthCache(data) {
        try {
            GLib.mkdir_with_parents(CACHE_DIR, 0o700);
            const file = Gio.File.new_for_path(CACHE_FILE);
            const bytes = new TextEncoder().encode(JSON.stringify(data));
            file.replace_contents(
                bytes, null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (e) {
            logTag(`cache write failed: ${e.message}`);
        }
    }

    // ---------- render ----------

    _classifyOauth() {
        if (!this._lastOauth) return 'dead';
        if (this._oauthFailStreak >= OAUTH_DEAD_MAX_FAILS) return 'dead';
        const age = Date.now() - this._lastOauth.fetchedAt;
        if (age >= OAUTH_DEAD_AFTER_MS) return 'dead';
        if (age >= OAUTH_STALE_AFTER_MS) return 'stale';
        return 'fresh';
    }

    _activeBlock() {
        const blocks = this._ccusageData?.blocks || [];
        return blocks.find(b => b.isActive) || null;
    }

    _classifyCcusage() {
        if (this._ccusageError || !this._ccusageData) return 'dead';
        return this._activeBlock() ? 'fresh' : 'idle';
    }

    // The limits[] entry the server rates worst, or null when everything is
    // normal. Drives the top-bar emoji and the extra top-bar percentage.
    _worstLimit() {
        const limits = Array.isArray(this._lastOauth?.limits) ? this._lastOauth.limits : [];
        let worst = null;
        let worstRank = SEV_NORMAL;
        for (const limit of limits) {
            const rank = severityRank(limit?.severity);
            if (rank > worstRank) {
                worstRank = rank;
                worst = limit;
            }
        }
        return worst;
    }

    // Row `i` of the scoped pool, creating it (and everything before it) if the
    // pool hasn't grown that far yet.
    _scopedRow(i) {
        while (this._scopedRows.length <= i) {
            const main  = new PopupMenu.PopupMenuItem('', {reactive: false});
            const reset = new PopupMenu.PopupMenuItem('', {reactive: false});
            main.label.add_style_class_name('claude-usage-mono');
            reset.label.add_style_class_name('claude-usage-mono');
            this._scopedSection.addMenuItem(main);
            this._scopedSection.addMenuItem(reset);
            this._scopedRows.push({main, reset});
        }
        return this._scopedRows[i];
    }

    _render() {
        const oauthState = this._classifyOauth();
        const ccState    = this._classifyCcusage();

        // ---- OAuth menu rows ----
        // Each pct row writes its main line, plus an indented sub-row with the
        // absolute reset wall-clock (its own menu item, so it always renders).
        const setPctRow = (mainItem, resetItem, label, bucket, ageNote) => {
            if (!bucket) {
                mainItem.label.set_text(kv(label, 'unavailable — field missing in response'));
                resetItem.visible = false;
                return;
            }
            const bar = fmtBar(bucket.utilization);
            const pct = fmtPct(bucket.utilization).padStart(4);
            const reset = fmtUntilIso(bucket.resets_at);
            const valuePrefix = `${bar} ${pct}  `;   // everything left of "resets in"
            mainItem.label.set_text(kv(label, `${valuePrefix}resets in ${reset}${ageNote}`));
            const abs = fmtAbsIso(bucket.resets_at);
            if (abs) {
                // Align the absolute line under "resets in …", not under the bar.
                resetItem.label.set_text(' '.repeat(LABEL_WIDTH + valuePrefix.length) + `↳ ${abs}`);
                resetItem.visible = true;
            } else {
                resetItem.visible = false;
            }
        };

        const oauthReason = this._lastOauthError?.message || 'no data';
        const oauthAge = this._lastOauth ? fmtAgo(Date.now() - this._lastOauth.fetchedAt) : null;
        const ageNote = oauthState === 'stale' ? `  (${oauthAge})` : '';

        if (oauthState === 'dead') {
            if (this._lastOauth) {
                const five = this._lastOauth.five_hour;
                const seven = this._lastOauth.seven_day;
                this._sessionItem.label.set_text(
                    kv('Session (5h):', `unavailable — ${oauthReason} (last ${five ? fmtPct(five.utilization) : '—'}, ${oauthAge})`)
                );
                this._weekItem.label.set_text(
                    kv('Week (7d):', `unavailable — ${oauthReason} (last ${seven ? fmtPct(seven.utilization) : '—'}, ${oauthAge})`)
                );
            } else {
                this._sessionItem.label.set_text(kv('Session (5h):', `unavailable — ${oauthReason}`));
                this._weekItem.label.set_text(kv('Week (7d):', `unavailable — ${oauthReason}`));
            }
            this._sessionResetItem.visible = false;
            this._weekResetItem.visible = false;
        } else {
            setPctRow(this._sessionItem, this._sessionResetItem, 'Session (5h):', this._lastOauth.five_hour, ageNote);
            setPctRow(this._weekItem, this._weekResetItem, 'Week (7d):', this._lastOauth.seven_day, ageNote);
        }

        // ---- per-model weekly rows ----
        // Fed by the same payload as the two rows above, so a dead OAuth path
        // degrades these the same way rather than making them disappear.
        const scoped = scopedWeeklyLimits(this._lastOauth);
        scoped.forEach((limit, i) => {
            const row = this._scopedRow(i);
            const label = scopedLabel(limit.scope.model.display_name);
            row.main.visible = true;
            if (oauthState === 'dead') {
                row.main.label.set_text(
                    kv(label, `unavailable — ${oauthReason} (last ${fmtPct(limit.percent)}, ${oauthAge})`)
                );
                row.reset.visible = false;
            } else {
                setPctRow(row.main, row.reset, label,
                          {utilization: limit.percent, resets_at: limit.resets_at}, ageNote);
            }
        });
        for (let i = scoped.length; i < this._scopedRows.length; i++) {
            this._scopedRows[i].main.visible = false;
            this._scopedRows[i].reset.visible = false;
        }

        // ---- monthly spend row ----
        const spend = this._lastOauth?.spend;
        this._spendItem.visible = !!spend;
        if (spend) {
            const used = fmtMoney(spend.used);
            const limit = fmtMoney(spend.limit ?? spend.cap?.money);
            if (oauthState === 'dead') {
                this._spendItem.label.set_text(
                    kv('Spend (mo):', `unavailable — ${oauthReason} (last ${used} of ${limit}, ${oauthAge})`)
                );
            } else if (spend.enabled === false) {
                const why = spend.disabled_reason ? ` (${spend.disabled_reason})` : '';
                this._spendItem.label.set_text(kv('Spend (mo):', `off${why}`));
            } else {
                const bar = fmtBar(spend.percent);
                const pct = fmtPct(spend.percent).padStart(4);
                this._spendItem.label.set_text(
                    kv('Spend (mo):', `${bar} ${pct}  ${used} of ${limit}${ageNote}`)
                );
            }
        }

        // ---- ccusage menu rows ----
        if (ccState === 'fresh') {
            const a = this._activeBlock();
            this._tokensItem.label.set_text(kv('Tokens:',  fmtTokens(a.totalTokens ?? 0)));
            this._burnItem.label.set_text(kv('Burn:',     `${fmtTokens(a.burnRate?.tokensPerMinute)} tok/min`));
            this._costItem.label.set_text(kv('Cost:',      fmtUSD(a.costUSD)));
            this._endsItem.label.set_text(kv('Ends in:',   fmtMins(a.projection?.remainingMinutes)));
        } else if (ccState === 'idle') {
            this._tokensItem.label.set_text(kv('Tokens:',  '— (no active block)'));
            this._burnItem.label.set_text(kv('Burn:',      '—'));
            this._costItem.label.set_text(kv('Cost:',      '—'));
            this._endsItem.label.set_text(kv('Ends in:',   '—'));
        } else {
            this._tokensItem.label.set_text(kv('Tokens:',  `error — ${this._ccusageError ?? 'unknown'}`));
            this._burnItem.label.set_text(kv('Burn:',      '—'));
            this._costItem.label.set_text(kv('Cost:',      '—'));
            this._endsItem.label.set_text(kv('Ends in:',   '—'));
        }

        // ---- top bar ----
        this._label.set_text(this._buildTopBarText(oauthState, ccState));
    }

    _buildTopBarText(oauthState, ccState) {
        if (oauthState === 'dead' && ccState === 'dead') return '⚠️ usage';

        // A dead OAuth path has no trustworthy severity to report, so severity
        // only speaks while the path is fresh or stale.
        const worst = oauthState === 'dead' ? null : this._worstLimit();
        const worstRank = severityRank(worst?.severity);

        // Severity outranks path health: running out of quota is the more
        // actionable fact than one of the two data sources being down.
        let emoji;
        if (worstRank >= SEV_CRITICAL) emoji = '🔴';
        else if (worstRank >= SEV_WARNING) emoji = '🟡';
        else if (oauthState === 'dead' && ccState !== 'dead') emoji = '🟡';
        else if (ccState === 'idle' && (!this._lastOauth || (this._lastOauth.five_hour?.utilization ?? 0) === 0)) emoji = '⚪';
        else emoji = '🟢';

        const parts = [];
        if (oauthState !== 'dead' && this._lastOauth?.five_hour) {
            const star = oauthState === 'stale' ? '*' : '';
            parts.push(`${fmtPct(this._lastOauth.five_hour.utilization)}${star}`);
        }
        // A per-model limit in trouble is invisible in the 5h number, so name
        // it rather than leaving an unexplained red dot in the panel.
        const worstModel = worst?.scope?.model?.display_name;
        if (worstModel && worstRank >= SEV_WARNING) parts.push(`${worstModel} ${fmtPct(worst.percent)}`);
        if (ccState === 'fresh') {
            const a = this._activeBlock();
            parts.push(fmtTokens(a.totalTokens ?? 0));
            parts.push(fmtMins(a.projection?.remainingMinutes));
        } else if (ccState === 'idle') {
            parts.push('idle');
        }
        if (parts.length === 0) return `${emoji} usage`;
        return `${emoji} ${parts.join(' · ')}`;
    }

    _openInTerminal() {
        try {
            Gio.Subprocess.new(TERMINAL_CMD, Gio.SubprocessFlags.NONE);
        } catch (e) {
            Main.notify('Claude Usage', `Could not open terminal: ${e.message}`);
        }
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
        if (this._oauthCancellable) {
            this._oauthCancellable.cancel();
            this._oauthCancellable = null;
        }
        if (this._soup) {
            this._soup.abort();
            this._soup = null;
        }
        // The rows are children of the menu, so super.destroy() disposes them;
        // dropping the pool keeps this object from holding dead actors.
        this._scopedRows = [];
        this._scopedSection = null;
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._indicator = new ClaudeUsageIndicator();
        Main.panel.addToStatusArea('claude-usage', this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
