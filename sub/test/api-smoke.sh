#!/usr/bin/env bash
# Compatibility entry point: the test runner owns temporary data and ports.
set -euo pipefail
cd "$(dirname "$0")/.."
exec npm test
