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

# Classify whatever is already at DEST before clobbering it. The case worth
# shouting about: the repo was moved, leaving a symlink whose target is gone.
# GNOME Shell scans the extensions dir at login and skips broken links
# silently -- `gnome-extensions info` then answers "does not exist", which
# looks nothing like the path problem it actually is.
was_stale=0
if [ -L "$DEST" ]; then
    old_target="$(readlink "$DEST")"
    if [ ! -e "$DEST" ]; then
        was_stale=1
        echo "WARNING: stale symlink -- its target no longer exists:" >&2
        echo "           $DEST" >&2
        echo "        -> $old_target  (missing)" >&2
        echo >&2
        echo "That is why the extension stopped loading: GNOME Shell skips" >&2
        echo "broken links at login without reporting an error. Repointing it." >&2
        echo >&2
    elif [ "$old_target" = "$SRC" ]; then
        echo "Already pointing at this checkout; relinking is a no-op."
    else
        echo "Note: repointing away from another checkout:"
        echo "        $old_target"
        echo
    fi
fi

mkdir -p "$(dirname "$DEST")"
ln -sfn "$SRC" "$DEST"

echo "Installed: $DEST -> $SRC"
echo
echo "Next steps:"
echo "  1. Log out and back in (Wayland blocks live extension reloads)."
echo "  2. gnome-extensions enable $UUID"

if [ "$was_stale" -eq 1 ]; then
    echo
    echo "Because the link was broken, the running gnome-shell holds no record"
    echo "of this extension, so step 2 fails with \"does not exist\" until you"
    echo "have logged out and back in. Check whether you even need it:"
    echo "  gsettings get org.gnome.shell enabled-extensions"
    echo "If $UUID is already listed there,"
    echo "the indicator comes back by itself and you can skip step 2."
fi
