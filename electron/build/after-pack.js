// electron-builder afterPack hook: ad-hoc code-sign the packaged .app.
//
// `mac.identity: null` tells electron-builder to skip code signing entirely,
// which leaves the bundle carrying only the linker's ad-hoc signature on the
// main executable: `codesign -dv` reports `Identifier=Electron` and
// `Info.plist=not bound`. Nothing covers the Info.plist, the icon, or the
// helper apps. Gatekeeper then has no bundle signature to validate, and a DMG
// downloaded from GitHub (which arrives quarantined) can be reported as damaged
// rather than merely unsigned.
//
// Signing ad-hoc (`--sign -`) binds the whole bundle without an Apple
// Developer ID. The app still shows the "unidentified developer" prompt on
// first launch, but right-click -> Open works and the signature verifies.
const { execFileSync } = require('child_process');
const path = require('path');

// Building inside a cloud-synced folder (Google Drive, Dropbox, iCloud) leaves
// com.apple.FinderInfo / resource-fork xattrs on the packed files, and the sync
// daemon can re-stamp them at any moment. codesign rejects them as "resource
// fork, Finder information, or similar detritus not allowed". Strip the whole
// output tree immediately before each codesign call. Set MDVIEWER_OUT to a path
// outside the synced folder to avoid the race entirely.
function strip(dir) { execFileSync('xattr', ['-cr', dir], { stdio: 'inherit' }); }

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  strip(context.appOutDir);
  // --deep is deprecated for Developer ID signing but remains the supported way
  // to ad-hoc sign nested helper bundles in one pass.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  strip(context.appOutDir);
  execFileSync('codesign', ['--verify', '--strict', '--deep', app], { stdio: 'inherit' });
  console.log('  • ad-hoc signed  ' + app);
};
