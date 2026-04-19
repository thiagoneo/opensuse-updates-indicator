/*
 * openSUSE Updates Indicator – Preferences
 * Copyright 2025 – GPL-3.0-or-later
 */

import Adw    from 'gi://Adw';
import Gtk    from 'gi://Gtk';

import {ExtensionPreferences, gettext as _}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Update method definitions: short label (shown in dropdown) +
// full description (shown as dynamic subtitle below the combo).
const UPDATE_METHODS = [
    { label: 'GNOME Software',              desc: 'Opens GNOME Software in update mode (graphical, no terminal)' },
    { label: 'GNOME PackageKit',            desc: 'Opens GNOME PackageKit update viewer (graphical, no terminal)' },
    { label: 'zypper dup',                  desc: 'Terminal: <priv> zypper dup' },
    { label: 'zypper ref → zypper dup',     desc: 'Terminal: <priv> zypper ref && <priv> zypper dup (refreshes repos first)' },
    { label: 'zypper dup + Flatpak',        desc: 'Terminal: <priv> zypper dup, then Flatpak update (single auth prompt)' },
    { label: 'zypper ref + dup + Flatpak',  desc: 'Terminal: <priv> zypper ref + dup, then Flatpak update (single auth prompt)' },
    { label: 'Flatpak only',                desc: 'Terminal: Flatpak update only (user installs without root; system with <priv>)' },
    { label: 'Custom command',              desc: 'Run the custom command specified below' },
];

export default class OpenSUSEUpdatesPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(700, 660);
        window.set_search_enabled(false);

        // ── Page 1: Basic ────────────────────────────────────────────────────
        const basicPage = new Adw.PreferencesPage({
            title: _('Basic'), icon_name: 'preferences-system-symbolic',
        });
        window.add(basicPage);

        // Visibility
        const visGroup = new Adw.PreferencesGroup({ title: _('Visibility') });
        basicPage.add(visGroup);
        visGroup.add(_switchRow(settings, 'always-visible',
            _('Always show indicator'),
            _('Keep the icon visible even when the system is up to date')));
        visGroup.add(_switchRow(settings, 'show-count',
            _('Show update count'),
            _('Display the total number of pending updates (zypper + Flatpak) next to the icon')));
        visGroup.add(_switchRow(settings, 'show-timechecked',
            _('Show last check time'),
            _('Display when the last check ran in the indicator menu')));

        // Timing
        const timingGroup = new Adw.PreferencesGroup({ title: _('Timing') });
        basicPage.add(timingGroup);
        timingGroup.add(_spinRow(settings, 'boot-wait',
            _('Startup delay (seconds)'),
            _('How long to wait after login before the first check'),
            0, 300, 1));
        timingGroup.add(_spinRow(settings, 'check-interval',
            _('Check interval (minutes)'),
            _('How often to check automatically. Set 0 to disable periodic checks.'),
            0, 10080, 5));

        // Notifications
        const notifGroup = new Adw.PreferencesGroup({ title: _('Notifications') });
        basicPage.add(notifGroup);
        notifGroup.add(_switchRow(settings, 'notify',
            _('Notify when new updates are found'),
            _('Show a GNOME notification when the check finds new packages')));

        // Update list display
        const listGroup = new Adw.PreferencesGroup({ title: _('Update list') });
        basicPage.add(listGroup);
        listGroup.add(_switchRow(settings, 'strip-versions',
            _('Hide version numbers'),
            _('Show only package names (without old→new versions) in the zypper update list')));
        listGroup.add(_spinRow(settings, 'auto-expand-list',
            _('Auto-expand list when ≤ N updates'),
            _('Automatically open the update lists if the total count is at most this many. 0 = never.'),
            0, 100, 1));

        // ── Page 2: Commands ─────────────────────────────────────────────────
        const cmdPage = new Adw.PreferencesPage({
            title: _('Commands'), icon_name: 'utilities-terminal-symbolic',
        });
        window.add(cmdPage);

        // zypper check
        const checkGroup = new Adw.PreferencesGroup({
            title:       _('zypper check command'),
            description: _('Runs to list available zypper updates. No root needed; reads the local cache only.'),
        });
        cmdPage.add(checkGroup);
        checkGroup.add(_entryRow(settings, 'check-cmd',
            _('Check command'),
            '/usr/bin/zypper --quiet --no-color --no-refresh list-updates'));

        // Flatpak check
        const flatpakGroup = new Adw.PreferencesGroup({
            title:       _('Flatpak'),
            description: _('When enabled, Flatpak updates are listed separately in the menu and included in the total count. The command is run via bash, so pipes and redirections work.'),
        });
        cmdPage.add(flatpakGroup);
        flatpakGroup.add(_switchRow(settings, 'check-flatpak',
            _('Check for Flatpak updates'),
            _('Run a separate flatpak check after each zypper check')));
        flatpakGroup.add(_entryRow(settings, 'check-flatpak-cmd',
            _('Flatpak check command'),
            'flatpak remote-ls --updates --columns=application,version (see docs for 3-column version)'));
        flatpakGroup.add(_switchRow(settings, 'flatpak-user-only',
            _('User installs only (no root needed)'),
            _('Pass --user to flatpak update. Use this if you only have user-installed Flatpaks or want to avoid the password prompt for system ones.')));

        // Update command
        const updateGroup = new Adw.PreferencesGroup({
            title:       _('Update command'),
            description: _('Launched when you click "Update now" in the indicator menu.'),
        });
        cmdPage.add(updateGroup);

        const comboRow = new Adw.ComboRow({ title: _('Update method') });
        const model = new Gtk.StringList();
        UPDATE_METHODS.forEach(m => model.append(m.label));
        comboRow.set_model(model);

        const updateComboSubtitle = () => {
            const idx = comboRow.get_selected();
            const m = UPDATE_METHODS[idx];
            const priv = settings.get_string('priv-escalation');
            comboRow.subtitle = m.desc.replace(/<priv>/g, priv);
        };

        const savedOpt = settings.get_int('update-cmd-options');
        comboRow.set_selected(savedOpt);
        updateComboSubtitle();

        comboRow.connect('notify::selected', () => {
            settings.set_int('update-cmd-options', comboRow.get_selected());
            updateComboSubtitle();
            syncCustomRow();
        });
        // Also refresh subtitle when priv escalation changes
        settings.connect('changed::priv-escalation', updateComboSubtitle);
        updateGroup.add(comboRow);

        const customRow = _entryRow(settings, 'update-cmd',
            _('Custom command'),
            _('Full command, e.g.: sudo zypper dup'));
        updateGroup.add(customRow);
        const syncCustomRow = () => { customRow.visible = (comboRow.get_selected() === 7); };
        syncCustomRow();

        // Privilege escalation
        const privGroup = new Adw.PreferencesGroup({
            title:       _('Privilege escalation'),
            description: _('Method used to gain root for zypper and system Flatpak updates.'),
        });
        cmdPage.add(privGroup);

        const PRIV_OPTS = [
            { id: 'sudo',   label: 'sudo  (password in terminal)' },
            { id: 'pkexec', label: 'pkexec  (graphical dialog — recommended)' },
            { id: 'run0',   label: 'run0  (systemd/polkit)' },
        ];
        const privCombo = new Adw.ComboRow({
            title:    _('Escalation method'),
            subtitle: _('Used in front of zypper and flatpak update --system'),
        });
        const privModel = new Gtk.StringList();
        PRIV_OPTS.forEach(o => privModel.append(o.label));
        privCombo.set_model(privModel);
        const currentPriv = settings.get_string('priv-escalation');
        privCombo.set_selected(PRIV_OPTS.findIndex(o => o.id === currentPriv) || 0);
        privCombo.connect('notify::selected', () => {
            settings.set_string('priv-escalation', PRIV_OPTS[privCombo.get_selected()].id);
        });
        privGroup.add(privCombo);

        // Terminal settings
        const termGroup = new Adw.PreferencesGroup({
            title:       _('Terminal'),
            description: _('Used for all terminal-based update options. The extension always appends "bash -c \'SCRIPT\'" after your command, so you only need to provide the window-open part.'),
        });
        cmdPage.add(termGroup);

        termGroup.add(_entryRow(settings, 'terminal',
            _('Terminal command'),
            _('Examples: "gnome-terminal --"  "tilix -e"  "xterm -e"  "konsole -e"  "alacritty -e"')));

        termGroup.add(_switchRow(settings, 'pause-before-close',
            _('Wait for Enter before closing'),
            _('After the update finishes, print a message and keep the terminal open until you press Enter')));

        // ── Page 3: Advanced ─────────────────────────────────────────────────
        const advPage = new Adw.PreferencesPage({
            title: _('Advanced'), icon_name: 'preferences-other-symbolic',
        });
        window.add(advPage);

        const monGroup = new Adw.PreferencesGroup({
            title:       _('Directory monitor'),
            description: _('The extension watches this directory for changes (e.g. after zypper transactions) and schedules a new check automatically.'),
        });
        advPage.add(monGroup);
        monGroup.add(_entryRow(settings, 'zypper-dir', _('Monitored directory'), '/var/lib/zypp'));

        const posGroup = new Adw.PreferencesGroup({ title: _('Panel position') });
        advPage.add(posGroup);
        posGroup.add(_switchRow(settings, 'enable-positioning',
            _('Enable manual positioning'),
            _('Override the default right-panel placement')));

        const posCombo = new Adw.ComboRow({ title: _('Panel box') });
        const posModel = new Gtk.StringList();
        [_('Left'), _('Center'), _('Right')].forEach(l => posModel.append(l));
        posCombo.set_model(posModel);
        posCombo.set_selected(settings.get_int('position'));
        posCombo.connect('notify::selected', () => settings.set_int('position', posCombo.get_selected()));
        posGroup.add(posCombo);

        posGroup.add(_spinRow(settings, 'position-number',
            _('Position index'),
            _('Zero-based index within the chosen box'),
            0, 99, 1));
    }
}

// ── Widget factory helpers ───────────────────────────────────────────────────

function _switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({ title, subtitle });
    settings.bind(key, row, 'active', 0);
    return row;
}

function _spinRow(settings, key, title, subtitle = '', min, max, step) {
    const row = new Adw.SpinRow({
        title, subtitle,
        adjustment: new Gtk.Adjustment({ lower: min, upper: max, step_increment: step }),
    });
    settings.bind(key, row, 'value', 0);
    return row;
}

function _entryRow(settings, key, title, placeholder = '') {
    const row = new Adw.EntryRow({ title, show_apply_button: true });
    row.set_text(settings.get_string(key));
    row.connect('apply', () => settings.set_string(key, row.get_text()));
    settings.connect(`changed::${key}`, () => {
        const val = settings.get_string(key);
        if (row.get_text() !== val) row.set_text(val);
    });
    return row;
}
