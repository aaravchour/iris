#!/bin/bash
# HermesDeck — launcher for the Hermes Deck Electron HUD.
# Executes the vendored Electron runtime (LSUIElement-patched) with the
# bundled app source in Resources/app. Args pass through (e.g. --hidden).
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_SRC="$DIR/../Resources/app"
ELECTRON="$DIR/../Resources/Electron.app/Contents/MacOS/Electron"
exec "$ELECTRON" "$APP_SRC" "$@"
