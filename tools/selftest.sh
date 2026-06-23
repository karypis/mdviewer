#!/bin/bash
# Run the in-browser self-test in headless Chrome and print PASS/FAIL lines.
# Exercises the real render pipeline, CSS Custom Highlight, card layout, and
# DOM-selection -> source-offset comment insertion (the parts Node can't cover).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP="$(mktemp -d)"
cp "$ROOT/mdviewer.html" "$TMP/mdviewer.html"
"$CHROME" --headless=new --disable-gpu --no-sandbox --virtual-time-budget=5000 \
  --dump-dom "file://$TMP/mdviewer.html?selftest=1" > "$TMP/dom.html" 2>/dev/null
node -e '
const fs=require("fs");
const dom=fs.readFileSync(process.argv[1],"utf8");
const m=dom.match(/<pre id="selftest-out">([\s\S]*?)<\/pre>/);
if(!m){console.log("NO SELFTEST OUTPUT (page failed to run)");process.exit(2);}
const txt=m[1].replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&").replace(/&quot;/g,"\"");
console.log(txt);
process.exit(/SELFTEST OK/.test(txt)?0:1);
' "$TMP/dom.html"
code=$?
rm -rf "$TMP"
exit $code
