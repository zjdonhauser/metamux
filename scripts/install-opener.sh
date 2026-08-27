#!/usr/bin/env bash
# Compiles opener/metamux-opener.swift, assembles it into a minimal .app
# bundle at ~/Applications/metamux-opener.app, and ad-hoc code-signs it.
# Does NOT flip the default browser -- that's `metamux-opener --register`,
# a separate, deliberate step (macOS shows a confirmation dialog for it;
# see the README's "Link routing" section for exactly what to expect).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/opener/metamux-opener.swift"
APP_NAME="metamux-opener"
BUNDLE_ID="com.metamux.opener"
APP_DIR="$HOME/Applications/$APP_NAME.app"

if [[ ! -f "$SRC" ]]; then
  echo "error: source not found at $SRC" >&2
  exit 1
fi

if ! command -v swiftc >/dev/null; then
  echo "error: swiftc not found. Install Xcode Command Line Tools first (xcode-select --install)." >&2
  exit 1
fi

mkdir -p "$APP_DIR/Contents/MacOS"

echo "Compiling $SRC..."
swiftc -O "$SRC" -o "$APP_DIR/Contents/MacOS/$APP_NAME"

echo "Writing Info.plist..."
cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>metamux-opener</string>
  <key>CFBundleDisplayName</key><string>metamux-opener</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <!-- No Dock icon, no menu bar -- this app only ever runs to handle one
       URL event and exit (or --register/--test as a plain CLI call). -->
  <key>LSUIElement</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <!-- Registers metamux-opener as an eligible handler for http/https URLs
       -- this alone does NOT make it the DEFAULT handler (see --register,
       README "Link routing"), only an option macOS can offer. -->
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>metamux link opener</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>http</string>
        <string>https</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
PLIST

echo "Ad-hoc code-signing (no Developer ID -- local machine only)..."
codesign --force --deep --sign - "$APP_DIR"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
if [[ -x "$LSREGISTER" ]]; then
  echo "Registering the bundle with LaunchServices..."
  "$LSREGISTER" -f "$APP_DIR"
else
  echo "warning: lsregister not found at the expected path -- macOS should still" >&2
  echo "pick up the bundle the first time it's launched or via Finder." >&2
fi

echo ""
echo "Built: $APP_DIR"
echo ""
echo "Verify without touching the real default browser:"
echo "  \"$APP_DIR/Contents/MacOS/$APP_NAME\" --test cmux https://example.com"
echo "  \"$APP_DIR/Contents/MacOS/$APP_NAME\" --test passthrough https://example.com"
echo ""
echo "To make metamux-opener your default browser (macOS will show a"
echo "confirmation dialog -- click 'Use metamux-opener'; if no dialog"
echo "appears, do it manually via System Settings, printed by --register too):"
echo ""
echo "  \"$APP_DIR/Contents/MacOS/$APP_NAME\" --register"
