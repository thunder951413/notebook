#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/release.sh <version> [build-number] [--dry-run] [--no-push]

Examples:
  ./scripts/release.sh 1.0.1
  ./scripts/release.sh 1.0.1 42
  ./scripts/release.sh 1.0.1 --dry-run

Behavior:
  1. Checks that the git worktree is clean
  2. Updates MARKETING_VERSION and CURRENT_PROJECT_VERSION in Notebook.xcodeproj/project.pbxproj
  3. Creates a release commit
  4. Creates an annotated git tag like v1.0.1
  5. Pushes the commit and tag to origin, which triggers GitHub release workflow

Options:
  --dry-run  Show planned changes without modifying files or git state
  --no-push  Create commit and tag locally, but do not push to origin
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

VERSION=""
BUILD_NUMBER=""
DRY_RUN=0
NO_PUSH=0

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      usage
      exit 0
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --no-push)
      NO_PUSH=1
      ;;
    *)
      if [[ -z "$VERSION" ]]; then
        VERSION="$arg"
      elif [[ -z "$BUILD_NUMBER" ]]; then
        BUILD_NUMBER="$arg"
      else
        echo "Unexpected argument: $arg" >&2
        usage
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "Version is required." >&2
  usage
  exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9]+(\.[0-9]+){1,2}$ ]]; then
  echo "Invalid version: $VERSION. Expected format like 1.0.1" >&2
  exit 1
fi

if [[ -z "$BUILD_NUMBER" ]]; then
  BUILD_NUMBER="$(date +%Y%m%d%H%M)"
fi

if [[ ! "$BUILD_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "Invalid build number: $BUILD_NUMBER. Expected digits only." >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO_ROOT" ]]; then
  echo "This script must be run inside a git repository." >&2
  exit 1
fi

cd "$REPO_ROOT"

PROJECT_FILE="Notebook.xcodeproj/project.pbxproj"
TAG="v$VERSION"
COMMIT_MESSAGE="chore: release $TAG"
HAS_ORIGIN_REMOTE=0

if [[ ! -f "$PROJECT_FILE" ]]; then
  echo "Project file not found: $PROJECT_FILE" >&2
  exit 1
fi

WORKTREE_STATUS="$(git status --short)"

if git remote get-url origin >/dev/null 2>&1; then
  HAS_ORIGIN_REMOTE=1
  git fetch --tags origin >/dev/null 2>&1 || true
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag already exists locally: $TAG" >&2
  exit 1
fi

if [[ "$HAS_ORIGIN_REMOTE" -eq 1 ]] && git ls-remote --tags origin "refs/tags/$TAG" | grep -q "$TAG"; then
  echo "Tag already exists on origin: $TAG" >&2
  exit 1
fi

CURRENT_VERSION="$(grep -m1 'MARKETING_VERSION = ' "$PROJECT_FILE" | sed -E 's/.*MARKETING_VERSION = ([^;]+);/\1/')"
CURRENT_BUILD="$(grep -m1 'CURRENT_PROJECT_VERSION = ' "$PROJECT_FILE" | sed -E 's/.*CURRENT_PROJECT_VERSION = ([^;]+);/\1/')"

echo "Preparing release:"
echo "  Version:      $CURRENT_VERSION -> $VERSION"
echo "  Build:        $CURRENT_BUILD -> $BUILD_NUMBER"
echo "  Tag:          $TAG"
echo "  Project file: $PROJECT_FILE"
echo "  Commit:       $COMMIT_MESSAGE"

if [[ "$DRY_RUN" -eq 1 ]]; then
  if [[ -n "$WORKTREE_STATUS" ]]; then
    echo "  Note: working tree is currently not clean; a real release would be blocked."
  fi
  if [[ "$HAS_ORIGIN_REMOTE" -eq 0 ]]; then
    echo "  Note: no origin remote configured locally; a real release push would be blocked."
  fi
  echo "Dry run enabled. No files or git state changed."
  exit 0
fi

if [[ -n "$WORKTREE_STATUS" ]]; then
  echo "Working tree is not clean. Commit or stash changes before releasing." >&2
  exit 1
fi

if [[ "$NO_PUSH" -eq 0 && "$HAS_ORIGIN_REMOTE" -eq 0 ]]; then
  echo "Remote 'origin' is not configured. Add it or use --no-push." >&2
  exit 1
fi

python3 - "$PROJECT_FILE" "$VERSION" "$BUILD_NUMBER" <<'PY'
from pathlib import Path
import re
import sys

project_file = Path(sys.argv[1])
version = sys.argv[2]
build_number = sys.argv[3]
text = project_file.read_text()
text = re.sub(r"MARKETING_VERSION = [^;]+;", f"MARKETING_VERSION = {version};", text)
text = re.sub(r"CURRENT_PROJECT_VERSION = [^;]+;", f"CURRENT_PROJECT_VERSION = {build_number};", text)
project_file.write_text(text)
PY

git add "$PROJECT_FILE"
git commit -m "$COMMIT_MESSAGE"
git tag -a "$TAG" -m "Release $TAG"

if [[ "$NO_PUSH" -eq 1 ]]; then
  echo "Release commit and tag created locally."
  echo "Push manually when ready:"
  echo "  git push origin HEAD"
  echo "  git push origin $TAG"
  exit 0
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git push origin "$CURRENT_BRANCH"
git push origin "$TAG"

echo "Release pushed successfully."
echo "GitHub Actions should now build and publish release $TAG."
