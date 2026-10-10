#!/usr/bin/env bash
set -euo pipefail

iconset="icons/app.iconset"
mkdir -p "$iconset"

sips -z 16 16 icons/app-512.png --out "$iconset/icon_16x16.png" >/dev/null
sips -z 32 32 icons/app-512.png --out "$iconset/icon_16x16@2x.png" >/dev/null
sips -z 32 32 icons/app-512.png --out "$iconset/icon_32x32.png" >/dev/null
sips -z 64 64 icons/app-512.png --out "$iconset/icon_32x32@2x.png" >/dev/null
sips -z 128 128 icons/app-512.png --out "$iconset/icon_128x128.png" >/dev/null
sips -z 256 256 icons/app-512.png --out "$iconset/icon_128x128@2x.png" >/dev/null
sips -z 256 256 icons/app-512.png --out "$iconset/icon_256x256.png" >/dev/null
sips -z 512 512 icons/app-512.png --out "$iconset/icon_256x256@2x.png" >/dev/null
sips -z 512 512 icons/app-512.png --out "$iconset/icon_512x512.png" >/dev/null
sips -z 1024 1024 icons/app-512.png --out "$iconset/icon_512x512@2x.png" >/dev/null

iconutil -c icns "$iconset" -o icons/app.icns
