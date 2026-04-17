/*
 * openSUSE Updates Indicator – Preferences
 * Copyright 2025 – GPL-3.0-or-later
 */

import Adw    from 'gi://Adw';
import Gtk    from 'gi://Gtk';
import GObject from 'gi://GObject';

import {ExtensionPreferences, gettext as _}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Labels for the update-cmd-options integer setting (index = option number)
const UPDATE_CMD_LABELS = [
    /* 0 */ 'GNOME Software (GUI)',
    /* 1 */ 'GNOME PackageKit (GUI)',
    /* 2 */ 'Terminal: sudo zypper dup',
    /* 3 */ 'Terminal: sudo zypper ref && sudo zypper dup',
    /* 4 */ 'Terminal: sudo zypper dup && flatpak update',
    /* 5 */ 'Terminal: sudo zypper ref && sudo zypper dup && flatpak update',
    /* 6 */ 'Terminal: flatpak update  (Flatpak only)',
    /* 7 */ 'Custom command',
];

export default class OpenSUSEUpdatesPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(700, 640);
        window.set_search_enabled(false);

        // ── Page 1: Basic ────────────────────────────────────────────────────
        const basicPage = new Adw.PreferencesPage({
            title:     _('Basic'),
            icon_name: 'preferences-system-symbolic',
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
            _('Display the number of pending updates next to the icon (zypper + Flatpak combined)')));
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
            _('Show a GNOME notification when the update check finds new packages')));

        // Update list
        const listGroup = new Adw.PreferencesGroup({ title: _('Update list') });
        basicPage.add(listGroup);
        listGroup.add(_switchRow(settings, 'strip-versions',
            _('Hide version numbers'),
            _('Show only package names (no old→new versions) in the zypper update list')));
        listGroup.add(_spinRow(settings, 'auto-expand-list',
            _('Auto-expand list when ≤ N updates'),
            _('Automatically open the update lists if the total count is at most this many. 0 = never.'),
            0, 100, 1));

        // ── Page 2: Commands ─────────────────────────────────────────────────
        const cmdPage = new Adw.PreferencesPage({
            title:     _('Commands'),
            icon_name: 'utilities-terminal-symbolic',
        });
        window.add(cmdPage);

        // Check command (zypper)
        const checkGroup = new Adw.PreferencesGroup({
            title:       _('zypper check command'),
            description: _('Runs to list available zypper updates. No root needed; reads the local cache.'),
        });
        cmdPage.add(checkGroup);
        checkGroup.add(_entryRow(settings, 'check-cmd',
            _('Check command'),
            '/usr/bin/zypper --quiet --no-color --no-refresh list-updates'));

        // Flatpak check
        const flatpakGroup = new Adw.PreferencesGroup({
            title:       _('Flatpak'),
            description: _('When enabled, Flatpak updates are listed separately in the menu and included in the total count.'),
        });
        cmdPage.add(flatpakGroup);
        flatpakGroup.add(_switchRow(settings, 'check-flatpak',
            _('Check for Flatpak updates'),
            _('Run a separate flatpak check after each zypper check')));
        flatpakGroup.add(_entryRow(settings, 'check-flatpak-cmd',
            _('Flatpak check command'),
            'flatpak remote-ls --updates --columns=application'));

        // Update command
        const updateGroup = new Adw.PreferencesGroup({
            title:       _('Update command'),
            description: _('Launched when you click "Update now" in the indicator menu.'),
        });
        cmdPage.add(updateGroup);

        const comboRow = new Adw.ComboRow({
            title:    _('Update method'),
            subtitle: _('Application or command used to apply updates'),
        });
        const model = new Gtk.StringList();
        UPDATE_CMD_LABELS.forEach(l => model.append(l));
        comboRow.set_model(model);
        comboRow.set_selected(settings.get_int('update-cmd-options'));
        comboRow.connect('notify::selected', () => {
            settings.set_int('update-cmd-options', comboRow.get_selected());
            syncCustomRow();
        });
        updateGroup.add(comboRow);

        const customRow = _entryRow(settings, 'update-cmd',
            _('Custom command'),
            _('Full command to run, e.g.: gnome-terminal -- bash -c \'sudo zypper dup\''));
        updateGroup.add(customRow);

        const syncCustomRow = () => {
            customRow.visible = (comboRow.get_selected() === 7);
        };
        syncCustomRow();

        updateGroup.add(_entryRow(settings, 'terminal',
            _('Terminal emulator command'),
            _('Used for terminal-based update options, e.g.: gnome-terminal -- bash -c')));

        // ── Page 3: Advanced ─────────────────────────────────────────────────
        const advPage = new Adw.PreferencesPage({
            title:     _('Advanced'),
            icon_name: 'preferences-other-symbolic',
        });
        window.add(advPage);

        const monGroup = new Adw.PreferencesGroup({
            title:       _('Directory monitor'),
            description: _('The extension watches this directory for changes (e.g. after applying updates) and schedules a new check automatically. Default: /var/lib/zypp'),
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
        title,
        subtitle,
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
