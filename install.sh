#!/usr/bin/env bash
# Symlink this checkout into ~/.local/share/gnome-shell/extensions/<uuid>
# so GNOME Shell loads the repo directly. Edits to the repo become live
# after a logout/login (Wayland) or `gnome-extensions disable && enable`
# on X11.
set -euo pipefail

UUID="claude-usage@iboalali.github.io"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
    echo "Refusing to overwrite existing non-symlink: $DEST" >&2
    echo "Move it aside or remove it manually first." >&2
    exit 1
fi

mkdir -p "$(dirname "$DEST")"
ln -sfn "$SRC" "$DEST"

echo "Installed: $DEST -> $SRC"
echo
echo "Next steps:"
echo "  1. Log out and back in (Wayland blocks live extension reloads)."
echo "  2. gnome-extensions enable $UUID"
