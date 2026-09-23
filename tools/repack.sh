#!/bin/bash
# Rebuild the installed macOS app from the current sources without
# electron-builder, by repacking its app.asar. Use this when
# electron/node_modules is unreadable (a cloud-only Google Drive folder) and
# `npm run dist` cannot run. The Electron binary and frameworks are reused from
# an existing bundle; only main.js, preload.js, links.js, session.js,
# mdviewer.html, and the version fields change.
#
#   bash tools/repack.sh                   # build into $OUT (default: /tmp/mdviewer-repack)
#   bash tools/repack.sh --install         # ...then replace /Applications/mdviewer.app
#
# Environment: SRC_APP (bundle to copy from, default /Applications/mdviewer.app),
# OUT (work directory). The replaced bundle is zipped into ~/mdviewer-backups;
# a bare .app there would be registered by Launch Services as a second copy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_APP="${SRC_APP:-/Applications/mdviewer.app}"
OUT="${OUT:-/tmp/mdviewer-repack}"
INSTALL=0
[ "${1:-}" = "--install" ] && INSTALL=1

VERSION="$(node "$ROOT/tools/version.js")"
BUILD="$(node "$ROOT/tools/version.js" --build)"
echo "version $VERSION build $BUILD"

node "$ROOT/tools/build.js"
mkdir -p "$OUT"
cd "$OUT"
[ -x node_modules/.bin/asar ] || npm i --silent --no-audit --no-fund @electron/asar
rm -rf app app.asar mdviewer.app
npx asar extract "$SRC_APP/Contents/Resources/app.asar" app
for f in main.js preload.js links.js session.js; do cp "$ROOT/electron/$f" app/; done
cp "$ROOT/mdviewer.html" app/mdviewer.html
node -e '
  const fs = require("fs"); const p = "app/package.json";
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.version = process.argv[1]; j.buildVersion = process.argv[2];
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$VERSION" "$BUILD"
npx asar pack app app.asar

ditto "$SRC_APP" mdviewer.app
cp app.asar mdviewer.app/Contents/Resources/app.asar
PLIST=mdviewer.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" "$PLIST"
xattr -cr mdviewer.app
codesign --force --deep --sign - mdviewer.app 2>/dev/null
xattr -cr mdviewer.app
codesign --verify --strict --deep mdviewer.app
echo "built $OUT/mdviewer.app ($VERSION, $BUILD)"

if [ "$INSTALL" = 1 ]; then
  if pgrep -f "/Applications/mdviewer.app/Contents/MacOS/mdviewer" >/dev/null; then
    osascript -e 'tell application "mdviewer" to quit' || true
    sleep 2
  fi
  mkdir -p "$HOME/mdviewer-backups"
  if [ -d /Applications/mdviewer.app ]; then
    OLD="$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" /Applications/mdviewer.app/Contents/Info.plist 2>/dev/null || echo unknown)"
    STAMP="$(date +%Y-%m-%d-%H%M%S)"
    mv /Applications/mdviewer.app "$OUT/old.app"
    ditto -c -k --keepParent "$OUT/old.app" "$HOME/mdviewer-backups/mdviewer-$OLD-$STAMP.app.zip"
    rm -rf "$OUT/old.app"
  fi
  ditto mdviewer.app /Applications/mdviewer.app
  codesign --verify --strict --deep /Applications/mdviewer.app
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/mdviewer.app
  echo "installed /Applications/mdviewer.app ($VERSION, $BUILD); previous bundle zipped in ~/mdviewer-backups"
fi
