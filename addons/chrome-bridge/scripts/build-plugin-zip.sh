#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('plugin.json','utf8')).version)")
SLUG=$(node -e "console.log(JSON.parse(require('fs').readFileSync('plugin.json','utf8')).slug)")
ZIP_NAME="${SLUG}-${VERSION}.zip"

echo "=== Building ${ZIP_NAME} ==="

echo ""
echo "--- npm ci (root) ---"
npm ci

echo ""
echo "--- npm run build (worker) ---"
npm run build

echo ""
echo "--- npm test ---"
npm test

echo ""
echo "--- packaging ---"
DIST_DIR="$PROJECT_DIR/dist"
STAGING_DIR=$(mktemp -d)
PLUGIN_DIR="$STAGING_DIR/${SLUG}-${VERSION}"

mkdir -p "$PLUGIN_DIR" "$DIST_DIR"
trap 'rm -rf "$STAGING_DIR"' EXIT

INCLUDE_FILES=(
  plugin.json
  Containerfile
  package.json
  package-lock.json
  tsconfig.json
  tsconfig.build.json
  README.md
)
for f in "${INCLUDE_FILES[@]}"; do
  if [ -f "$f" ]; then
    cp "$f" "$PLUGIN_DIR/"
  else
    echo "WARNING: Missing root file: $f"
  fi
done

INCLUDE_DIRS=(
  src
  claude-resources
  extension
)
for d in "${INCLUDE_DIRS[@]}"; do
  if [ -d "$d" ]; then
    cp -r "$d" "$PLUGIN_DIR/"
  else
    echo "WARNING: Missing directory: $d"
  fi
done

find "$PLUGIN_DIR" -type d -name "node_modules" -prune -exec rm -rf {} +
find "$PLUGIN_DIR" -type f -name "*.test.ts" -delete
find "$PLUGIN_DIR" -type d -name "__tests__" -prune -exec rm -rf {} +
find "$PLUGIN_DIR" -type d -name "test-utils" -prune -exec rm -rf {} +

rm -f "$DIST_DIR/$ZIP_NAME"
if command -v zip >/dev/null 2>&1; then
  (cd "$STAGING_DIR" && zip -rq "$DIST_DIR/$ZIP_NAME" "${SLUG}-${VERSION}/")
else
  python3 -c 'import shutil, sys; shutil.make_archive(sys.argv[1], "zip", root_dir=sys.argv[2], base_dir=sys.argv[3])' \
    "$DIST_DIR/${ZIP_NAME%.zip}" "$STAGING_DIR" "${SLUG}-${VERSION}"
fi

echo ""
echo "=== Built: dist/${ZIP_NAME} ==="
echo "WARNING: UNSIGNED dev artifact. Requires SPEEDWAVE_ALLOW_UNSIGNED=1 to install."
echo ""
echo "Contents (top-level):"
LISTING_FILE="$STAGING_DIR/listing.txt"
python3 -c 'import zipfile, sys; print("\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))' "$DIST_DIR/$ZIP_NAME" > "$LISTING_FILE"
head -25 "$LISTING_FILE"
echo "..."
echo ""
tail -3 "$LISTING_FILE"
