#!/bin/bash
# Our own Mac build, on any Mac, in one command (replaces the GitHub Actions Mac job).
#   bash scripts/build-mac.sh            -> app talks to the live server
#   bash scripts/build-mac.sh --staging  -> app talks to techsupport-staging (for tests)
# Installs only per-user tools (Rust in ~/.cargo, Bun in ~/.bun). The one system-wide piece is
# Apple's Command Line Tools, which macOS installs itself after a Yes box (needed by every Mac build).
# Output: release-out/mac-<version>/Tech-Support-mac.zip (+ .sha256). Same steps as release.yml.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

if [ "${1:-}" = "--staging" ]; then export TS_SERVER="https://techsupport-staging.westwardconsulting.ai"; fi

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Apple's Command Line Tools are missing. A box opens: click Install, wait for it to finish, then run this again."
  xcode-select --install || true
  exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
  [ -f "$HOME/.cargo/env" ] || curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
  . "$HOME/.cargo/env"
fi
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
if ! command -v bun >/dev/null 2>&1; then
  [ -x "$HOME/.bun/bin/bun" ] || curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

VERSION=$(sed -n 's/^ *"version": "\(.*\)",/\1/p' app/src-tauri/tauri.conf.json | head -1)
echo "building Tech Support $VERSION ($(git rev-parse --short HEAD)) for Mac${TS_SERVER:+ against $TS_SERVER}"

cd app
bun install --frozen-lockfile
(cd src-tauri && mkdir -p ../dist && touch ../dist/index.html && cargo test --lib)
# Updater files need the private key, which stays on the server side; without it, build the app only.
EXTRA=()
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then EXTRA=(--config '{"bundle":{"createUpdaterArtifacts":false}}'); fi
./node_modules/.bin/tauri build --target universal-apple-darwin --bundles app "${EXTRA[@]}"

APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/Tech Support.app"
codesign --verify --deep --strict "$APP"
OUT="$ROOT/release-out/mac-$VERSION"
mkdir -p "$OUT"
ditto -c -k --keepParent "$APP" "$OUT/Tech-Support-mac.zip"
TGZ="src-tauri/target/universal-apple-darwin/release/bundle/macos/Tech Support.app.tar.gz"
[ -f "$TGZ" ] && cp "$TGZ" "$OUT/Tech-Support-mac.app.tar.gz" && cp "$TGZ.sig" "$OUT/Tech-Support-mac.app.tar.gz.sig"
(cd "$OUT" && shasum -a 256 Tech-Support-mac.zip > Tech-Support-mac.zip.sha256)
echo "done: $OUT"
