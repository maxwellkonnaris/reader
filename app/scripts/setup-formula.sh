#!/usr/bin/env bash
# One-time setup for display-equation recognition (electron/formula.js).
#
# Per research/15-formula-recognition.md: breezedeus/pix2text-mfr, MIT code
# and MIT weights, ~113 MB of plain ONNX -- no export step needed (unlike
# Kokoro's setup-speech.sh, which has to build its own export because the
# stock release lacks a duration output; pix2text-mfr's stock release is
# already what we want).
#
# This step needs a normal internet connection and touches huggingface.co.
# It was NOT run by whoever/whatever wrote this script against the real
# files -- huggingface.co is blocked by policy in that sandbox (confirmed via
# the agent proxy's status endpoint, a genuine org denial, not routed around).
# So: the file names and sizes below are taken from research/15's own
# measurements, not verified fresh here. If any curl 404s, open
# https://huggingface.co/breezedeus/pix2text-mfr/tree/main in a browser and
# fix the filename -- HF repos do get reorganised.
set -euo pipefail

HOME_DIR="${BLITZ_FORMULA_HOME:-$HOME/.local/share/blitz-formula}"
mkdir -p "$HOME_DIR"
REPO="https://huggingface.co/breezedeus/pix2text-mfr/resolve/main"

fetch() {
  local file="$1" expect_bytes="$2"
  if [ -f "$HOME_DIR/$file" ]; then
    echo "==> $file already present, skipping"
    return
  fi
  echo "==> $file"
  curl -fL --progress-bar -o "$HOME_DIR/$file.part" "$REPO/$file"
  mv "$HOME_DIR/$file.part" "$HOME_DIR/$file"
  if [ -n "$expect_bytes" ]; then
    actual=$(stat -c%s "$HOME_DIR/$file" 2>/dev/null || stat -f%z "$HOME_DIR/$file")
    if [ "$actual" != "$expect_bytes" ]; then
      echo "    WARNING: expected $expect_bytes bytes, got $actual -- the repo may have changed" >&2
    fi
  fi
}

fetch "encoder_model.onnx" 87496990
fetch "decoder_model.onnx" 30114937
# Exact filename unverified -- HF repos vary between tokenizer.json (a fast
# tokenizer, what electron/formula.js expects) and a vocab.json+merges.txt
# pair (a slow tokenizer, which formula.js does NOT currently load). If this
# 404s, check the repo's file list and adjust.
fetch "tokenizer.json" ""
# Either of these, if present, gives formula.js the real special-token ids
# instead of its unverified guess -- see loadSpecialIds() in formula.js.
curl -fL -o "$HOME_DIR/generation_config.json" "$REPO/generation_config.json" 2>/dev/null \
  || curl -fL -o "$HOME_DIR/config.json" "$REPO/config.json" 2>/dev/null \
  || echo "==> no generation_config.json or config.json found -- formula.js will guess and warn loudly"

echo "==> verifying the sessions load and the tokenizer decodes"
node --experimental-vm-modules -e "
import('$PWD/electron/formula.js').then(async (f) => {
  const ok = await f.warm();
  console.log(ok ? '    formula engine ready in $HOME_DIR' : '    FAILED -- see error above');
  process.exit(ok ? 0 : 1);
});
"
