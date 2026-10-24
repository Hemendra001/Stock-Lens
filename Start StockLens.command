#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo 'StockLens needs Node.js 20 or newer. Install it from https://nodejs.org, then run this file again.'
  read -r 'reply?Press Return to close.'
  exit 1
fi
node scripts/bundle.mjs || exit 1
bash scripts/build.sh || exit 1
echo 'Open http://127.0.0.1:4173 in your browser. Keep this window open while using StockLens. Press Ctrl+C to stop.'
node scripts/dev.mjs
