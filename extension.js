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

        // OAuth percentages on top — they're the more important number
        this._sessionItem = new PopupMenu.PopupMenuItem('Session (5h):', {reactive: false});
        this._weekItem    = new PopupMenu.PopupMenuItem('Week (7d):',    {reactive: false});
        this.menu.addMenuItem(this._sessionItem);
        this.menu.addMenuItem(this._weekItem);
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
        for (const item of [this._sessionItem, this._weekItem,
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
                    logTag(`OAuth ok: 5h=${data?.five_hour?.utilization} 7d=${data?.seven_day?.utilization}`);
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

    _render() {
        const oauthState = this._classifyOauth();
        const ccState    = this._classifyCcusage();

        // ---- OAuth menu rows ----
        const renderPctRow = (label, bucket, ageNote) => {
            if (!bucket) return kv(label, 'unavailable — field missing in response');
            const bar = fmtBar(bucket.utilization);
            const pct = fmtPct(bucket.utilization).padStart(4);
            const reset = fmtUntilIso(bucket.resets_at);
            return kv(label, `${bar} ${pct}  resets in ${reset}${ageNote}`);
        };

        if (oauthState === 'dead') {
            const reason = this._lastOauthError?.message || 'no data';
            if (this._lastOauth) {
                const age = fmtAgo(Date.now() - this._lastOauth.fetchedAt);
                const five = this._lastOauth.five_hour;
                const seven = this._lastOauth.seven_day;
                this._sessionItem.label.set_text(
                    kv('Session (5h):', `unavailable — ${reason} (last ${five ? fmtPct(five.utilization) : '—'}, ${age})`)
                );
                this._weekItem.label.set_text(
                    kv('Week (7d):', `unavailable — ${reason} (last ${seven ? fmtPct(seven.utilization) : '—'}, ${age})`)
                );
            } else {
                this._sessionItem.label.set_text(kv('Session (5h):', `unavailable — ${reason}`));
                this._weekItem.label.set_text(kv('Week (7d):', `unavailable — ${reason}`));
            }
        } else {
            const ageNote = oauthState === 'stale'
                ? `  (${fmtAgo(Date.now() - this._lastOauth.fetchedAt)})`
                : '';
            this._sessionItem.label.set_text(renderPctRow('Session (5h):', this._lastOauth.five_hour, ageNote));
            this._weekItem.label.set_text(renderPctRow('Week (7d):', this._lastOauth.seven_day, ageNote));
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

        let emoji;
        if (oauthState === 'dead' && ccState !== 'dead') emoji = '🟡';
        else if (ccState === 'idle' && (!this._lastOauth || (this._lastOauth.five_hour?.utilization ?? 0) === 0)) emoji = '⚪';
        else emoji = '🟢';

        const parts = [];
        if (oauthState !== 'dead' && this._lastOauth?.five_hour) {
            const star = oauthState === 'stale' ? '*' : '';
            parts.push(`${fmtPct(this._lastOauth.five_hour.utilization)}${star}`);
        }
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
