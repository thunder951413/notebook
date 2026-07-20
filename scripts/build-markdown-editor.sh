#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EDITOR_DIR="$ROOT_DIR/Tools/MarkdownEditor"
MARKTEXT_DIR="${MARKTEXT_DIR:-$(cd "$ROOT_DIR/../marktext" 2>/dev/null && pwd)}"

if [[ ! -x "$MARKTEXT_DIR/node_modules/.bin/vite" ]]; then
  print -u2 "MarkText dependencies are unavailable: $MARKTEXT_DIR"
  exit 1
fi

ln -sfn "$MARKTEXT_DIR/node_modules" "$EDITOR_DIR/node_modules"
"$MARKTEXT_DIR/node_modules/.bin/vite" build --config "$EDITOR_DIR/vite.config.js" "$EDITOR_DIR"
rm -f "$EDITOR_DIR/node_modules"

print "Offline Markdown editor built into Notebook/MarkdownEditor.bundle"
