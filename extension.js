/*
 * openSUSE Updates Indicator
 * GNOME Shell extension — indicator for Tumbleweed and Slowroll updates
 *
 * Copyright 2025 – GPL-3.0-or-later
 *
 * Inspired by:
 *   Arch Linux Updates Indicator – Raphaël Rochet (GPL-3.0)
 *   Debian Linux Updates Indicator – Gianni Lerro (GPL-3.0)
 */

import Clutter from 'gi://Clutter';
import St      from 'gi://St';
import GObject from 'gi://GObject';
import Gio     from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib    from 'gi://GLib';

import * as Main        from 'resource:///org/gnome/shell/ui/main.js';
import {Button}         from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu   from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Util        from 'resource:///org/gnome/shell/misc/util.js';
import {Extension, gettext as _, ngettext as __}
    from 'resource:///org/gnome/shell/extensions/extension.js';

// ---------------------------------------------------------------------------
// zypper --quiet list-updates output:
//   "v | repo | package | old-ver | new-ver | arch"   (regular update)
//   "s | ..."                                          (security update)
// Header lines start with a capital letter; separator lines start with "-".
// We only match lines that begin with a lowercase letter or "!".
// ---------------------------------------------------------------------------
const RE_ZypperLine  = /^\s*[a-z!]\s*\|/;

// Flatpak app IDs always contain at least one dot (e.g. org.gnome.Calculator).
// This excludes header lines like "Application" emitted by some flatpak versions.
const RE_FlatpakLine = /^[a-zA-Z][a-zA-Z0-9_-]*(\.[a-zA-Z][a-zA-Z0-9_-]*)+/;

function parseZypperLine(line) {
    const p = line.split('|').map(s => s.trim());
    if (p.length < 5) return null;
    return { status: p[0], repo: p[1], name: p[2], curVer: p[3], newVer: p[4], arch: p[5] ?? '' };
}

// ---------------------------------------------------------------------------
// State that survives extension disable/enable cycles (screen lock etc.)
// ---------------------------------------------------------------------------
let FIRST_BOOT      = 1;
let UPDATES_PENDING = -1;  // -1 unknown, -2 error, -3 checking, >=0 count
let UPDATES_LIST    = [];
let FLATPAK_PENDING = 0;
let FLATPAK_LIST    = [];
let LAST_CHECK      = undefined;

// Settings mirrors
let ALWAYS_VISIBLE    = true;
let SHOW_COUNT        = true;
let SHOW_TIMECHECKED  = true;
let NOTIFY            = false;
let BOOT_WAIT         = 15;
let CHECK_INTERVAL    = 3600;
let CHECK_CMD         = '/usr/bin/zypper --quiet --no-color --no-refresh list-updates';
let CHECK_FLATPAK     = false;
let CHECK_FLATPAK_CMD = 'flatpak remote-ls --updates --columns=application 2>/dev/null';
let UPDATE_CMD_OPT    = 2;
let UPDATE_CMD        = '';
let TERMINAL_CMD      = 'gnome-terminal --';
let PAUSE_BEFORE_CLOSE = true;
let STRIP_VERSIONS    = false;
let AUTO_EXPAND_LIST  = 0;
let ZYPPER_DIR        = '/var/lib/zypp';
let PRIV_ESC          = 'sudo';          // sudo | pkexec | run0
let FLATPAK_USER_ONLY = false;

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
export default class OpenSUSEUpdatesExtension extends Extension {
    enable() {
        this._indicator = new OpenSUSEUpdateIndicator(this);
        this._indicator._positionChanged();
    }
    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}

// ---------------------------------------------------------------------------
// Panel indicator
// ---------------------------------------------------------------------------
const OpenSUSEUpdateIndicator = GObject.registerClass(
    {
        _TimeoutId:               null,
        _FirstTimeoutId:          null,
        _updateProcess_sourceId:  null,
        _updateProcess_stream:    null,
        _updateProcess_pid:       null,
        _updateList:              [],
        _flatpakProcess_sourceId: null,
        _flatpakProcess_stream:   null,
        _flatpakProcess_pid:      null,
        _flatpakList:             [],
    },
class OpenSUSEUpdateIndicator extends Button {

    _init(ext) {
        console.log('opensuse-updates-indicator: loading');
        super._init(0.5);
        this._extension = ext;

        // Subprocess launcher with LANG=C for reproducible output
        this._launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        this._launcher.setenv('LANG', 'C', true);

        // ── Panel button ────────────────────────────────────────────────────
        this.updateIcon = new St.Icon({
            gicon:       this._getIcon('opensuse-unknown-symbolic'),
            style_class: 'system-status-icon',
        });
        this.label = new St.Label({
            text: '', y_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        const box = new St.BoxLayout({ vertical: false, style_class: 'panel-status-menu-box' });
        box.add_child(this.updateIcon);
        box.add_child(this.label);
        this.add_child(box);

        // ── Menu items ───────────────────────────────────────────────────────

        // Expandable zypper update list
        this.menuExpander = new PopupMenu.PopupSubMenuMenuItem('');
        this.menuExpanderContainer = new St.BoxLayout({
            vertical: true, style_class: 'opensuse-updates-list',
        });
        this.menuExpander.menu.box.add_child(this.menuExpanderContainer);

        // Expandable flatpak update list
        this.flatpakExpander = new PopupMenu.PopupSubMenuMenuItem('');
        this.flatpakExpanderContainer = new St.BoxLayout({
            vertical: true, style_class: 'opensuse-updates-list',
        });
        this.flatpakExpander.menu.box.add_child(this.flatpakExpanderContainer);
        this.flatpakExpander.visible = false;

        // "Last checked" info line (non-interactive)
        this.timeCheckedMenu = new PopupMenu.PopupMenuItem('-', { reactive: false });

        // Actions
        this.updateNowMenuItem = new PopupMenu.PopupMenuItem(_('Update now'));
        this.checkNowMenuItem  = new PopupMenu.PopupMenuItem(_('Check now'));

        // "Checking…" item with cancel button
        this.checkingMenuItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        const checkingLabel   = new St.Label({ text: _('Checking…') });
        const cancelButton    = new St.Button({
            child: new St.Icon({ icon_name: 'process-stop-symbolic' }),
            style_class: 'system-menu-action opensuse-updates-cancel-btn',
            x_expand: true,
        });
        cancelButton.set_x_align(Clutter.ActorAlign.END);
        this.checkingMenuItem.add_child(checkingLabel);
        this.checkingMenuItem.add_child(cancelButton);

        const settingsMenuItem = new PopupMenu.PopupMenuItem(_('Settings'));

        // Assemble menu
        this.menu.addMenuItem(this.menuExpander);
        this.menu.addMenuItem(this.flatpakExpander);
        this.menu.addMenuItem(this.timeCheckedMenu);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this.updateNowMenuItem);
        this.menu.addMenuItem(this.checkingMenuItem);
        this.menu.addMenuItem(this.checkNowMenuItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(settingsMenuItem);

        // ── Signal connections ────────────────────────────────────────────
        this.menu.connect('open-state-changed', this._onMenuOpened.bind(this));
        this.checkNowMenuItem.connect('activate', this._checkUpdates.bind(this));
        cancelButton.connect('clicked', this._cancelCheck.bind(this));
        this.updateNowMenuItem.connect('activate', this._updateNow.bind(this));
        settingsMenuItem.connect('activate', () => this._extension.openPreferences());

        // ── Initial display state ─────────────────────────────────────────
        this._showChecking(false);
        this._updateZypperExpander(false, _('Waiting for first check…'));
        this._updateList  = UPDATES_LIST;
        this._flatpakList = FLATPAK_LIST;
        if (LAST_CHECK) this._updateLastCheckMenu();

        // ── Load GSettings ────────────────────────────────────────────────
        this._settings = this._extension.getSettings();
        this._settingsChangedId = this._settings.connect('changed', this._applySettings.bind(this));
        this._applySettings();

        // ── Schedule first check ──────────────────────────────────────────
        if (FIRST_BOOT) {
            this._FirstTimeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, BOOT_WAIT, () => {
                    this._FirstTimeoutId = null;
                    this._checkUpdates();
                    FIRST_BOOT = 0;
                    return false;
                }
            );
        }

        Main.panel.addToStatusArea('OpenSUSEUpdateIndicator', this);
    }

    // ── Icon helpers ──────────────────────────────────────────────────────────
    _getIcon(name) {
        return Gio.icon_new_for_string(
            this._extension.dir.get_child('icons').get_path() + '/' + name + '.svg'
        );
    }

    // ── Panel positioning ─────────────────────────────────────────────────────
    _positionChanged() {
        if (!this._settings) return;
        if (this._settings.get_boolean('enable-positioning')) {
            this.container.get_parent().remove_child(this.container);
            const boxes = { 0: Main.panel._leftBox, 1: Main.panel._centerBox, 2: Main.panel._rightBox };
            boxes[this._settings.get_int('position')]
                .insert_child_at_index(this.container, this._settings.get_int('position-number'));
        }
    }

    // ── Settings ──────────────────────────────────────────────────────────────
    _applySettings() {
        ALWAYS_VISIBLE     = this._settings.get_boolean('always-visible');
        SHOW_COUNT         = this._settings.get_boolean('show-count');
        SHOW_TIMECHECKED   = this._settings.get_boolean('show-timechecked');
        NOTIFY             = this._settings.get_boolean('notify');
        BOOT_WAIT          = this._settings.get_int('boot-wait');
        CHECK_INTERVAL     = 60 * this._settings.get_int('check-interval');
        CHECK_CMD          = this._settings.get_string('check-cmd');
        CHECK_FLATPAK      = this._settings.get_boolean('check-flatpak');
        CHECK_FLATPAK_CMD  = this._settings.get_string('check-flatpak-cmd');
        UPDATE_CMD_OPT     = this._settings.get_int('update-cmd-options');
        UPDATE_CMD         = this._settings.get_string('update-cmd');
        TERMINAL_CMD       = this._settings.get_string('terminal');
        PAUSE_BEFORE_CLOSE = this._settings.get_boolean('pause-before-close');
        STRIP_VERSIONS     = this._settings.get_boolean('strip-versions');
        AUTO_EXPAND_LIST   = this._settings.get_int('auto-expand-list');
        ZYPPER_DIR         = this._settings.get_string('zypper-dir');
        PRIV_ESC           = this._settings.get_string('priv-escalation');
        FLATPAK_USER_ONLY  = this._settings.get_boolean('flatpak-user-only');

        this.timeCheckedMenu.visible = SHOW_TIMECHECKED;

        if (!CHECK_FLATPAK) {
            FLATPAK_PENDING   = 0;
            FLATPAK_LIST      = [];
            this._flatpakList = [];
            this.flatpakExpander.visible = false;
        }

        this._checkShowHide();
        this._updateStatus();
        this._startDirectoryMonitor();
        this._scheduleCheck();
        this._positionChanged();
    }

    // ── Build the terminal update command ─────────────────────────────────────
    //
    // The fundamental rule: TERMINAL_CMD is only the "open a window" part,
    // e.g. "gnome-terminal --" or "tilix -e" or "xterm -e".
    // We ALWAYS inject "bash -c 'SCRIPT'" ourselves so that &&, ;, quotes,
    // and any other shell syntax work correctly regardless of the terminal.
    //
    // The final argv passed to spawnCommandLine looks like:
    //   gnome-terminal -- bash -c 'sudo zypper dup; ...'
    //   tilix -e bash -c 'sudo zypper dup; ...'
    //
    // ── Privilege escalation helper ──────────────────────────────────────────
    //
    // Returns the privilege escalation prefix to use in front of zypper/flatpak.
    //
    // sudo   → asks for password in the terminal
    // pkexec → pops a graphical polkit dialog (no terminal password prompt)
    // run0   → systemd polkit wrapper, typically graphical on desktop sessions
    //
    _priv() { return PRIV_ESC; }   // 'sudo' | 'pkexec' | 'run0'

    // Build the flatpak update command that respects FLATPAK_USER_ONLY.
    // User flatpaks never need root; system flatpaks do.
    _flatpakCmd() {
        if (FLATPAK_USER_ONLY) {
            // No privilege escalation needed for --user
            return 'flatpak update --user -y';
        } else {
            // Update user installs first (no root), then system installs with priv
            return `flatpak update --user -y; ${this._priv()} flatpak update --system -y`;
        }
    }

    _buildScript(commands) {
        let script = commands.join(' && ');
        if (PAUSE_BEFORE_CLOSE)
            script += '; echo; echo "--- Pressione Enter para fechar / Press Enter to close ---"; read -r _';
        return script;
    }

    _inTerminal(commands) {
        // Escape any single quotes that might appear in commands
        const script = this._buildScript(commands).replace(/'/g, "\'");
        // Always inject bash -c explicitly so &&, ;, pipes etc. work regardless
        // of whether the terminal is gnome-terminal, tilix, xterm, konsole, etc.
        return `${TERMINAL_CMD} bash -c '${script}'`;
    }

    _getUpdateCommand() {
        const P = this._priv();
        switch (UPDATE_CMD_OPT) {
            case 0: return '/usr/bin/gnome-software --mode updates';
            case 1: return '/usr/bin/gpk-update-viewer';
            case 2: return this._inTerminal([`${P} zypper dup`]);
            case 3: return this._inTerminal([`${P} zypper ref`, `${P} zypper dup`]);
            case 4: return this._inTerminal([`${P} zypper dup`, this._flatpakCmd()]);
            case 5: return this._inTerminal([`${P} zypper ref`, `${P} zypper dup`, this._flatpakCmd()]);
            case 6: return this._inTerminal([this._flatpakCmd()]);
            case 7: return UPDATE_CMD || '/usr/bin/gnome-software --mode updates';
            default: return '/usr/bin/gnome-software --mode updates';
        }
    }

    _updateNow() {
        Util.spawnCommandLine(this._getUpdateCommand());
    }

    // ── Periodic check scheduling ─────────────────────────────────────────────
    _scheduleCheck() {
        if (this._TimeoutId) GLib.source_remove(this._TimeoutId);
        if (CHECK_INTERVAL <= 0) return;

        let delay = CHECK_INTERVAL;
        if (LAST_CHECK) {
            delay -= (new Date() - LAST_CHECK) / 1000;
            if (delay < BOOT_WAIT) delay = BOOT_WAIT;
        }

        console.log(`opensuse-updates-indicator: next check in ${Math.round(delay)}s`);
        this._TimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._TimeoutId = null;
            this._checkUpdates();
            return false;
        });
    }

    // ── Directory monitor (re-check when zypp DB changes) ────────────────────
    _startDirectoryMonitor() {
        if (this._monitorPath && this._monitorPath !== ZYPPER_DIR) {
            this._monitor.cancel();
            this._monitor    = null;
            this._monitorPath = null;
        }
        if (ZYPPER_DIR && !this._monitorPath) {
            this._monitorPath = ZYPPER_DIR;
            const dir = Gio.file_new_for_path(ZYPPER_DIR);
            this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', this._onDirectoryChanged.bind(this));
        }
    }

    _onDirectoryChanged() {
        if (this._FirstTimeoutId) GLib.source_remove(this._FirstTimeoutId);
        this._FirstTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this._FirstTimeoutId = null;
            this._checkUpdates();
            FIRST_BOOT = 0;
            return false;
        });
    }

    // ── Visibility ────────────────────────────────────────────────────────────
    _checkShowHide() {
        if (UPDATES_PENDING === -3) return;
        const total = Math.max(0, UPDATES_PENDING) + FLATPAK_PENDING;
        if (UPDATES_PENDING === -2) {
            this.visible = true;
        } else if (!ALWAYS_VISIBLE && total < 1) {
            this.visible = false;
        } else {
            this.visible = true;
        }
        this.label.visible = SHOW_COUNT && total > 0;
        if (this.label.visible)
            this.label.set_text(total.toString());
    }

    _onMenuOpened() { this._maybeAutoExpand(); }

    _maybeAutoExpand() {
        const total = Math.max(0, UPDATES_PENDING) + FLATPAK_PENDING;
        if (this.menu.isOpen && total > 0 && total <= AUTO_EXPAND_LIST) {
            this.menuExpander.setSubmenuShown(UPDATES_PENDING > 0);
            this.flatpakExpander.setSubmenuShown(FLATPAK_PENDING > 0);
        } else {
            this.menuExpander.setSubmenuShown(false);
            this.flatpakExpander.setSubmenuShown(false);
        }
    }

    // ── Checking indicator ────────────────────────────────────────────────────
    _showChecking(active) {
        if (active) {
            this.updateIcon.set_gicon(this._getIcon('opensuse-unknown-symbolic'));
            this.checkNowMenuItem.visible = false;
            this.checkingMenuItem.visible = true;
        } else {
            this.checkNowMenuItem.visible = true;
            this.checkingMenuItem.visible = false;
        }
    }

    _updateLastCheckMenu() {
        this.timeCheckedMenu.label.set_text(
            _('Last checked:') + '  ' + LAST_CHECK.toLocaleString()
        );
        this.timeCheckedMenu.visible = SHOW_TIMECHECKED;
    }

    // ── Master status update (called after both async checks complete) ─────────
    _updateStatus(zypperCount) {
        const nZ    = typeof zypperCount === 'number' ? zypperCount : UPDATES_PENDING;
        const nF    = FLATPAK_PENDING;
        const total = Math.max(0, nZ) + nF;

        // ── zypper section ───────────────────────────────────────────────────
        if (nZ > 0) {
            this.updateIcon.set_gicon(this._getIcon('opensuse-updates-symbolic'));
            this._updateZypperExpander(
                true,
                __('%d zypper update pending', '%d zypper updates pending', nZ).format(nZ)
            );
        } else if (nZ === -2) {
            this.updateIcon.set_gicon(this._getIcon('opensuse-error-symbolic'));
            this._updateZypperExpander(false, _('Error running check command. See GNOME logs.'));
        } else if (nZ === -1) {
            this.updateIcon.set_gicon(this._getIcon('opensuse-unknown-symbolic'));
            this._updateZypperExpander(false, '');
        } else {
            // nZ === 0
            if (nF === 0) {
                this.updateIcon.set_gicon(this._getIcon('opensuse-uptodate-symbolic'));
                this._updateZypperExpander(false, _('System is up to date :)'));
            } else {
                // Only flatpak updates remain
                this.updateIcon.set_gicon(this._getIcon('opensuse-updates-symbolic'));
                this._updateZypperExpander(false, _('zypper: up to date'));
            }
            UPDATES_LIST = [];
        }

        // ── flatpak section ──────────────────────────────────────────────────
        if (CHECK_FLATPAK && nF > 0) {
            this._updateFlatpakExpander(
                true,
                __('%d Flatpak update pending', '%d Flatpak updates pending', nF).format(nF)
            );
        } else {
            this.flatpakExpander.visible = false;
        }

        // ── notification ─────────────────────────────────────────────────────
        if (NOTIFY && UPDATES_PENDING < nZ && total > 0) {
            const names = this._updateList
                .map(l => parseZypperLine(l)?.name ?? l)
                .concat(this._flatpakList.filter(l => l.trim()))
                .join(', ');
            this._showNotification(
                __('New openSUSE Update', 'New openSUSE Updates', total),
                names
            );
        }

        UPDATES_PENDING = nZ;
        UPDATES_LIST    = nZ > 0 ? this._updateList : [];
        FLATPAK_LIST    = nF > 0 ? this._flatpakList : [];

        this.label.set_text(total > 0 ? total.toString() : '');
        this._maybeAutoExpand();
        this._checkShowHide();
    }

    // ── Zypper update list submenu ────────────────────────────────────────────
    _updateZypperExpander(enabled, label) {
        if (!label) {
            this.menuExpander.visible = false;
            this._setUpdateNowActive(false);
            return;
        }

        this.menuExpander.reactive          = enabled;
        this.menuExpander._triangle.visible = enabled;
        this.menuExpander.label.set_text(label);
        this.menuExpander.visible           = true;

        if (enabled)
            this.menuExpander.remove_style_class_name('popup-inactive-menu-item');
        else
            this.menuExpander.add_style_class_name('popup-inactive-menu-item');

        if (enabled && this._updateList.length > 0) {
            this.menuExpanderContainer.destroy_all_children();
            this._updateList.forEach(line => {
                const info = parseZypperLine(line);
                if (!info) return;

                const hbox = new St.BoxLayout({ vertical: false, style_class: 'opensuse-update-line' });

                if (info.status === 's')
                    hbox.add_child(new St.Label({ text: '🔒 ', style_class: 'opensuse-update-security' }));

                hbox.add_child(new St.Label({
                    text: info.name, x_expand: true, style_class: 'opensuse-update-name',
                }));

                if (!STRIP_VERSIONS) {
                    hbox.add_child(new St.Label({ text: info.curVer + ' → ', style_class: 'opensuse-update-ver-from' }));
                    hbox.add_child(new St.Label({ text: info.newVer,          style_class: 'opensuse-update-ver-to'   }));
                }

                this.menuExpanderContainer.add_child(hbox);
            });
        }

        this._setUpdateNowActive(enabled || FLATPAK_PENDING > 0);
    }

    // ── Flatpak update list submenu ───────────────────────────────────────────
    _updateFlatpakExpander(enabled, label) {
        this.flatpakExpander.reactive          = enabled;
        this.flatpakExpander._triangle.visible = enabled;
        this.flatpakExpander.label.set_text(label);
        this.flatpakExpander.visible           = true;

        if (enabled)
            this.flatpakExpander.remove_style_class_name('popup-inactive-menu-item');
        else
            this.flatpakExpander.add_style_class_name('popup-inactive-menu-item');

        if (enabled && this._flatpakList.length > 0) {
            this.flatpakExpanderContainer.destroy_all_children();
            this._flatpakList.forEach(appId => {
                if (!appId.trim()) return;
                const row = new St.BoxLayout({ vertical: false, style_class: 'opensuse-update-line' });
                row.add_child(new St.Label({ text: '📦 ', style_class: 'opensuse-update-flatpak-icon' }));
                row.add_child(new St.Label({
                    text: appId.trim(), x_expand: true, style_class: 'opensuse-update-name',
                }));
                this.flatpakExpanderContainer.add_child(row);
            });
        }

        this._setUpdateNowActive(enabled || UPDATES_PENDING > 0);
    }

    _setUpdateNowActive(active) {
        this.updateNowMenuItem.reactive = active;
        if (active)
            this.updateNowMenuItem.remove_style_class_name('popup-inactive-menu-item');
        else
            this.updateNowMenuItem.add_style_class_name('popup-inactive-menu-item');
    }

    // ── Async zypper check ────────────────────────────────────────────────────
    _checkUpdates() {
        if (this._TimeoutId) { GLib.source_remove(this._TimeoutId); this._TimeoutId = null; }
        if (this._updateProcess_sourceId) return;

        this._showChecking(true);
        UPDATES_PENDING = -3;

        try {
            // Always run through bash so the user can use pipes, &&, 2>/dev/null etc. in check-cmd
            const argv = ['/bin/bash', '-c', CHECK_CMD];

            const [, pid, , out_fd] =
                GLib.spawn_async_with_pipes(null, argv, null, GLib.SpawnFlags.DO_NOT_REAP_CHILD, null);

            this._updateProcess_stream = new Gio.DataInputStream({
                base_stream: new GioUnix.InputStream({ fd: out_fd }),
            });
            this._updateProcess_sourceId =
                GLib.child_watch_add(0, pid, () => this._checkUpdatesRead());
            this._updateProcess_pid = pid;

        } catch (err) {
            console.error(`opensuse-updates-indicator: zypper check failed — ${err.message}`);
            this._showChecking(false);
            this._updateStatus(-2);
        }

        LAST_CHECK = new Date();
        this._updateLastCheckMenu();
        this._scheduleCheck();
    }

    _cancelCheck() {
        if (this._updateProcess_pid) {
            Util.spawnCommandLine('kill ' + this._updateProcess_pid);
            this._updateProcess_pid = null;
            this._checkUpdatesEnd();
        }
        if (this._flatpakProcess_pid) {
            Util.spawnCommandLine('kill ' + this._flatpakProcess_pid);
            this._flatpakProcess_pid = null;
            this._checkFlatpakEnd();
        }
    }

    _checkUpdatesRead() {
        const list = [];
        let line;
        do {
            [line] = this._updateProcess_stream.read_line_utf8(null);
            if (line) list.push(line);
        } while (line);
        this._updateList = list;
        this._checkUpdatesEnd();
    }

    _checkUpdatesEnd() {
        this._updateProcess_stream.close(null);
        this._updateProcess_stream   = null;
        GLib.source_remove(this._updateProcess_sourceId);
        this._updateProcess_sourceId = null;
        this._updateProcess_pid      = null;

        const count = this._updateList.filter(l => RE_ZypperLine.test(l)).length;
        UPDATES_PENDING = count;

        if (CHECK_FLATPAK) {
            this._checkFlatpak(); // _updateStatus is called inside _checkFlatpakEnd
        } else {
            this._showChecking(false);
            this._updateStatus(count);
        }
    }

    // ── Async flatpak check ───────────────────────────────────────────────────
    _checkFlatpak() {
        if (this._flatpakProcess_sourceId) return;

        try {
            // Always run through bash so the user can use pipes, &&, 2>/dev/null etc. in check-flatpak-cmd
            const argv = ['/bin/bash', '-c', CHECK_FLATPAK_CMD];

            const [, pid, , out_fd] =
                GLib.spawn_async_with_pipes(null, argv, null, GLib.SpawnFlags.DO_NOT_REAP_CHILD, null);

            this._flatpakProcess_stream = new Gio.DataInputStream({
                base_stream: new GioUnix.InputStream({ fd: out_fd }),
            });
            this._flatpakProcess_sourceId =
                GLib.child_watch_add(0, pid, () => this._checkFlatpakRead());
            this._flatpakProcess_pid = pid;

        } catch (err) {
            console.error(`opensuse-updates-indicator: flatpak check failed — ${err.message}`);
            FLATPAK_PENDING   = 0;
            this._flatpakList = [];
            this._showChecking(false);
            this._updateStatus(UPDATES_PENDING);
        }
    }

    _checkFlatpakRead() {
        const list = [];
        let line;
        do {
            [line] = this._flatpakProcess_stream.read_line_utf8(null);
            if (line) list.push(line);
        } while (line);
        this._flatpakList = list;
        this._checkFlatpakEnd();
    }

    _checkFlatpakEnd() {
        if (this._flatpakProcess_stream) {
            this._flatpakProcess_stream.close(null);
            this._flatpakProcess_stream = null;
        }
        if (this._flatpakProcess_sourceId) {
            GLib.source_remove(this._flatpakProcess_sourceId);
            this._flatpakProcess_sourceId = null;
        }
        this._flatpakProcess_pid = null;

        FLATPAK_PENDING = this._flatpakList.filter(l => RE_FlatpakLine.test(l)).length;
        FLATPAK_LIST    = this._flatpakList;

        this._showChecking(false);
        this._updateStatus(UPDATES_PENDING);
    }

    // ── GNOME notification ────────────────────────────────────────────────────
    _showNotification(title, body) {
        if (this._notification)
            this._notification.destroy(MessageTray.NotificationDestroyedReason.REPLACED);

        if (!this._notifSource) {
            this._notifSource = new MessageTray.Source({
                title: this._extension.metadata.name,
                icon:  this._getIcon('opensuse-lit-symbolic'),
            });
            this._notifSource.connect('destroy', () => { this._notifSource = null; });
            Main.messageTray.add(this._notifSource);
        }

        this._notification = new MessageTray.Notification({
            source: this._notifSource, title, body,
        });
        this._notification.gicon = this._getIcon('opensuse-updates-symbolic');
        this._notification.addAction(_('Update now'), () => this._updateNow());
        this._notification.connect('destroy', () => { this._notification = null; });
        this._notifSource.addNotification(this._notification);
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────
    destroy() {
        console.log('opensuse-updates-indicator: unloading');
        this._settings.disconnect(this._settingsChangedId);

        if (this._notifSource)             { this._notifSource.destroy(); this._notifSource = null; }
        if (this._monitor)                 { this._monitor.cancel(); this._monitor = null; this._monitorPath = null; }
        if (this._updateProcess_sourceId)  { GLib.source_remove(this._updateProcess_sourceId);  this._updateProcess_sourceId = null;  this._updateProcess_stream  = null; }
        if (this._flatpakProcess_sourceId) { GLib.source_remove(this._flatpakProcess_sourceId); this._flatpakProcess_sourceId = null; this._flatpakProcess_stream = null; }
        if (this._FirstTimeoutId)          { GLib.source_remove(this._FirstTimeoutId); this._FirstTimeoutId = null; }
        if (this._TimeoutId)               { GLib.source_remove(this._TimeoutId);      this._TimeoutId = null; }

        super.destroy();
    }
});
