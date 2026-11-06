#!/usr/bin/env bash
# Prepares a headless Chromium that runs in this devcontainer without root:
#   - libs (NSS, X11, ATK, ...) and fonts are fetched with `apt-get download`
#     and unpacked with `dpkg-deb -x` into e2e/.pw (no system changes);
#   - the playwright headless shell is downloaded into e2e/.pw/browsers unless
#     PLAYWRIGHT_BROWSERS_PATH already points at a directory that has it.
# Writes e2e/.pw/env.sh, which run-e2e.sh sources. Safe to re-run.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PW="$HERE/.pw"
mkdir -p "$PW/debs" "$PW/libs" "$PW/fonts" "$PW/fontcache"

PKGS=(libnss3=2:3.98-1build1 libnspr4 libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64
      libdrm2 libgbm1 libwayland-server0 libx11-6 libx11-data libxau6 libxcb-randr0 libxcb1 libxcomposite1
      libxdamage1 libxdmcp6 libxext6 libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxrender1)
FONTS=(fonts-dejavu-core fonts-liberation)

if [ ! -e "$PW/libs/.done" ]; then
  if ldconfig -p 2>/dev/null | grep -q libnss3.so; then
    echo "system already has libnss3; skipping lib download"
  else
    echo "downloading ${#PKGS[@]} lib packages..."
    (cd "$PW/debs" && apt-get download "${PKGS[@]}" >/dev/null)
    for d in "$PW"/debs/*.deb; do dpkg-deb -x "$d" "$PW/libs"; done
  fi
  touch "$PW/libs/.done"
fi
if [ ! -e "$PW/fonts/.done" ]; then
  echo "downloading fonts..."
  (cd "$PW/debs" && apt-get download "${FONTS[@]}" >/dev/null)
  for d in "$PW"/debs/fonts-*.deb; do dpkg-deb -x "$d" "$PW/fonts"; done
  touch "$PW/fonts/.done"
fi
rm -rf "$PW/debs"

cat > "$PW/fonts.conf" <<XML
<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig><dir>$PW/fonts/usr/share/fonts</dir><cachedir>$PW/fontcache</cachedir>
<alias><family>sans-serif</family><prefer><family>Liberation Sans</family></prefer></alias>
<alias><family>system-ui</family><prefer><family>Liberation Sans</family></prefer></alias>
<alias><family>monospace</family><prefer><family>DejaVu Sans Mono</family></prefer></alias></fontconfig>
XML

BROWSERS="${PLAYWRIGHT_BROWSERS_PATH:-$PW/browsers}"
if ! ls -d "$BROWSERS"/chromium_headless_shell-* >/dev/null 2>&1; then
  echo "downloading chromium headless shell into $BROWSERS ..."
  (cd "$HERE" && PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" npx --no-install playwright-core install chromium-headless-shell)
fi

LIB="$PW/libs/usr/lib/x86_64-linux-gnu"
cat > "$PW/env.sh" <<ENV
export LD_LIBRARY_PATH="$LIB:$LIB/gbm:\${LD_LIBRARY_PATH:-}"
export FONTCONFIG_FILE="$PW/fonts.conf"
export PLAYWRIGHT_BROWSERS_PATH="$BROWSERS"
ENV
echo "ok: wrote $PW/env.sh"
