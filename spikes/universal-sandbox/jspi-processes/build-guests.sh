#!/bin/sh
# Rebuilds the guest programs into web/wasm/. Needs: rustup target add wasm32-wasip1 wasm32-unknown-unknown
set -e
cd "$(dirname "$0")"
(cd guest && cargo build --release --target wasm32-wasip1)
(cd guest-reentrant && cargo build --release --target wasm32-unknown-unknown)
mkdir -p web/wasm
for p in producer upper count spin pingpong hog crash parent; do
  cp guest/target/wasm32-wasip1/release/$p.wasm web/wasm/
done
cp guest-reentrant/target/wasm32-unknown-unknown/release/reentrant.wasm web/wasm/
ls -l web/wasm
