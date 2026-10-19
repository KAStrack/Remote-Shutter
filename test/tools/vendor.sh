#!/usr/bin/env bash
# Copies third-party code from node_modules into docs/vendor/ (the app has no
# build step, so vendored files are committed). Run after `npm install`.
set -euo pipefail
cd "$(dirname "$0")/../.."
nm=node_modules
out=docs/vendor
mkdir -p "$out" docs/fonts

cp "$nm/qrcode-generator/dist/qrcode.mjs" "$out/qrcode-generator.mjs"

# jsQR is a UMD bundle; minify it (keeping its licence banner) for the worker.
npx --yes terser@5 "$nm/jsqr/dist/jsQR.js" --compress --mangle \
  --comments '/license|copyright/i' -o "$out/jsQR.min.js"
cp "$nm/jsqr/LICENSE" "$out/jsQR.LICENSE.txt"

cat > "$out/qrcode-generator.LICENSE.txt" <<'LIC'
QR Code Generator for JavaScript
Copyright (c) 2009 Kazuhiko Arase
Licensed under the MIT license: http://www.opensource.org/licenses/mit-license.php
LIC

cp "$nm/@fontsource-variable/jost/files/jost-latin-wght-normal.woff2" docs/fonts/jost-latin-wght.woff2
cp "$nm/@fontsource-variable/jost/LICENSE" docs/fonts/jost.LICENSE.txt
ls -la "$out" docs/fonts
