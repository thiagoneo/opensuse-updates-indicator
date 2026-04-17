# openSUSE Updates Indicator

A GNOME Shell extension for openSUSE Tumbleweed and Slowroll that displays pending updates in the panel and lets you choose how to apply them.

Inspired by Debian Linux Updates Indicator and Arch Linux Updates Indicator.

## Features

- Shows the number of pending updates in the GNOME panel.
- Lists `zypper` updates with package name, current version, and new version.
- Optional Flatpak update support.
- Actions to apply updates via:
  - GNOME Software
  - GNOME PackageKit
  - Terminal with `zypper`
- Configuration options for automatic checking, visibility, and notifications.

## Installation

1. Copy the `opensuse-updates-indicator` directory to your GNOME Shell extensions folder:

   ```bash
   cp -r /path/to/opensuse-updates-indicator ~/.local/share/gnome-shell/extensions/opensuse-updates-indicator@local
   ```

2. Restart GNOME Shell (press `Alt+F2`, type `r`, and press Enter) or log out and log back in.

3. Enable the extension using the `Extensions` app or `gnome-extensions`.

## Usage

- Click the panel icon to open the menu.
- See the number of pending updates and the last checked time.
- Choose `Update now` to launch the configured update method.
- Choose `Check now` to force a manual update check.
- The expandable list shows details for each package update.

## Configuration

The extension uses GSettings to define options such as:

- `CHECK_CMD`: the zypper check command.
- `CHECK_FLATPAK`: enable Flatpak update checking.
- `CHECK_INTERVAL`: automatic check interval.
- `TERMINAL_CMD`: terminal command used to run `zypper`.
- `SHOW_COUNT`: display the update count.
- `NOTIFY`: show notifications when updates are found.

Settings can be adjusted through the GNOME Shell preferences panel or via `dconf`/`gsettings`.

## Compatibility

Tested with GNOME Shell versions:

- 46
- 47
- 48
- 49

## License

GPL-3.0-or-later

## Contributing

Contributions are welcome. Feel free to open issues or pull requests for improvements, fixes, or support for new openSUSE versions.
