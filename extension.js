import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const REFRESH_SEC = 60;
const CCUSAGE = '/usr/local/bin/ccusage';
const CCUSAGE_ARGS = ['blocks', '--active', '--json', '--offline'];
const TERMINAL_CMD = ['/usr/bin/gnome-terminal', '--', 'bash', '-c',
    `${CCUSAGE} blocks --recent --offline; echo; read -n1 -r -p 'Press any key to close…'`];

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

        this._tokensItem = new PopupMenu.PopupMenuItem('Tokens: —', {reactive: false});
        this._burnItem   = new PopupMenu.PopupMenuItem('Burn:   —', {reactive: false});
        this._costItem   = new PopupMenu.PopupMenuItem('Cost:   —', {reactive: false});
        this._endsItem   = new PopupMenu.PopupMenuItem('Ends in: —', {reactive: false});
        this.menu.addMenuItem(this._tokensItem);
        this.menu.addMenuItem(this._burnItem);
        this.menu.addMenuItem(this._costItem);
        this.menu.addMenuItem(this._endsItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const openTermItem = new PopupMenu.PopupMenuItem('Open ccusage in terminal');
        openTermItem.connect('activate', () => this._openInTerminal());
        this.menu.addMenuItem(openTermItem);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this._refresh());
        this.menu.addMenuItem(refreshItem);

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) this._refresh();
        });

        this._timerId = 0;
        this._cancellable = null;
        this._refresh();
        this._startTimer();
    }

    _startTimer() {
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SEC, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _refresh() {
        if (this._cancellable) this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();

        let proc;
        try {
            proc = Gio.Subprocess.new(
                [CCUSAGE, ...CCUSAGE_ARGS],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );
        } catch (e) {
            this._setError(`spawn: ${e.message}`);
            return;
        }

        proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                if (!p.get_successful()) {
                    this._setError('ccusage exited non-zero');
                    return;
                }
                this._render(JSON.parse(stdout));
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._setError(`parse: ${e.message}`);
            }
        });
    }

    _render(data) {
        const blocks = (data && data.blocks) || [];
        const active = blocks.find(b => b.isActive);
        if (!active) {
            this._label.set_text('⚪ idle');
            this._tokensItem.label.set_text('Tokens: —');
            this._burnItem.label.set_text('Burn:   —');
            this._costItem.label.set_text('Cost:   —');
            this._endsItem.label.set_text('Ends in: —');
            return;
        }
        const tokens = active.totalTokens ?? 0;
        const remaining = active.projection?.remainingMinutes;
        const burn = active.burnRate?.tokensPerMinute;
        const cost = active.costUSD;

        this._label.set_text(`🟢 ${fmtTokens(tokens)} · ${fmtMins(remaining)}`);
        this._tokensItem.label.set_text(`Tokens: ${fmtTokens(tokens)}`);
        this._burnItem.label.set_text(`Burn:   ${fmtTokens(burn)} tok/min`);
        this._costItem.label.set_text(`Cost:   ${fmtUSD(cost)}`);
        this._endsItem.label.set_text(`Ends in: ${fmtMins(remaining)}`);
    }

    _setError(msg) {
        this._label.set_text('⚠️ usage');
        this._tokensItem.label.set_text(`Error: ${msg.slice(0, 80)}`);
        this._burnItem.label.set_text('Burn:   —');
        this._costItem.label.set_text('Cost:   —');
        this._endsItem.label.set_text('Ends in: —');
    }

    _openInTerminal() {
        try {
            Gio.Subprocess.new(TERMINAL_CMD, Gio.SubprocessFlags.NONE);
        } catch (e) {
            Main.notify('Claude Usage', `Could not open terminal: ${e.message}`);
        }
    }

    destroy() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
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
