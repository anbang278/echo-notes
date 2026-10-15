#!/bin/sh
set -eu
ASR_CONTROLLER=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ASR_BUILD=${1:-"$ASR_CONTROLLER/build/MLX ASR 控制台.app"}
mkdir -p "$ASR_BUILD/Contents/MacOS" "$ASR_BUILD/Contents/Resources"
/usr/bin/xcrun swiftc -O -target arm64-apple-macos13.0 -framework AppKit \
  "$ASR_CONTROLLER/ASRControl.swift" -o "$ASR_BUILD/Contents/MacOS/ASRControl"
cp "$ASR_CONTROLLER/Info.plist" "$ASR_BUILD/Contents/Info.plist"
/usr/bin/codesign --force --sign - "$ASR_BUILD"
"$ASR_BUILD/Contents/MacOS/ASRControl" --self-test
/usr/bin/codesign --verify --deep --strict "$ASR_BUILD"
echo "$ASR_BUILD"
