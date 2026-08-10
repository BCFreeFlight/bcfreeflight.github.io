#!/usr/bin/env bash
#
# Runs the test suite and exits non-zero if anything failed.
#
#   tests/run.sh
#
# The tests need a server, because they are ES modules that fetch fixtures, so
# one is started on a free port and stopped again on the way out. They run in
# Chrome because that is where the site runs: real modules, a real DOM, real
# SVG measurement. Nothing is installed — Node drives the browser over the
# DevTools protocol using its own fetch and WebSocket.
#
# To watch them instead, serve the repository and open tests/index.html.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${TEST_PORT:-8799}"

if ! command -v node >/dev/null; then
    echo "Node is needed to drive the browser. Or open tests/index.html yourself." >&2
    exit 2
fi

chrome="${CHROME:-}"
if [[ -z "$chrome" ]]; then
    for candidate in \
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        "/Applications/Chromium.app/Contents/MacOS/Chromium" \
        "$(command -v google-chrome || true)" \
        "$(command -v chromium || true)" \
        "$(command -v chromium-browser || true)"
    do
        if [[ -n "$candidate" && -x "$candidate" ]]; then chrome="$candidate"; break; fi
    done
fi

if [[ -z "$chrome" ]]; then
    echo "No Chrome found. Set CHROME=/path/to/chrome, or open tests/index.html yourself." >&2
    exit 2
fi

python3 -m http.server "$port" --directory "$root" >/dev/null 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT

# Wait for the server rather than guessing at a sleep.
for _ in $(seq 1 50); do
    if curl -fs -o /dev/null "http://localhost:$port/tests/index.html" 2>/dev/null; then break; fi
    sleep 0.1
done

# The query string is a cache-buster: without it a browser that has already run
# these tests once will happily re-run the previous version of them.
node "$root/tests/headless.mjs" "http://localhost:$port/tests/index.html?run=$$" "$chrome"
