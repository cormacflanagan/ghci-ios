#!/usr/bin/env bash
# Rebuilds web/mhs/mhs.{js,wasm}: the MicroHs REPL compiled to WebAssembly
# for a Web Worker.  Needs git, make, a C compiler and emcc (Emscripten) on PATH.
# Installs MicroHs into ~/.mcabal as a side effect (the compiler needs it).
set -euo pipefail

MHS_REPO=https://github.com/augustss/MicroHs.git
MHS_COMMIT=e40951905129ad2237ea563a7db9bc7fad515216

here=$(cd "$(dirname "$0")/.." && pwd)
work=${WORK:-$here/build}
out=$here/web/mhs

mkdir -p "$work"
if [ ! -d "$work/MicroHs/.git" ]; then
  git clone "$MHS_REPO" "$work/MicroHs"
fi
cd "$work/MicroHs"
git fetch --depth 1 origin "$MHS_COMMIT" 2>/dev/null || true
git checkout -f "$MHS_COMMIT"
git apply "$here/patches/microhs-web.patch"

make install
version=$(bin/mhs --numeric-version)
conf=$HOME/.mcabal/mhs-$version/packages/MicroHs-$version/data/mhs.conf

if ! grep -q '^\[emscripten_worker\]' "$conf"; then
  cat >> "$conf" <<'CONF'

-- Web worker build for the iPad app (heap: 32M cells = 256MB on wasm32)
[emscripten_worker]
cc = "emcc"
ccflags = "-O3 -sASYNCIFY -sASYNCIFY_STACK_SIZE=4194304 -sENVIRONMENT=worker -sEXPORTED_FUNCTIONS=['_main','_set_input_char','_set_max_c_depth'] -sEXPORTED_RUNTIME_METHODS=['FS'] -sFORCE_FILESYSTEM=1 -sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=1024MB -sTOTAL_STACK=5MB -DHEAP_CELLS=32000000 -DUSE_WEB_INPUT -Wno-address-of-packed-member"
cclibs = "-lm"
conf = "unix"
CONF
fi

mkdir -p "$out"
"$HOME/.mcabal/bin/mhs" -temscripten_worker -z -i -imhs -isrc MicroHs.Main \
  -o"$out/mhs.js" --embed-packages base
echo "MicroHs $version ($MHS_COMMIT)" > "$out/VERSION"
ls -l "$out"
