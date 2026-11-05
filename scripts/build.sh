#!/usr/bin/env bash
# language: Bash, file: scripts/build.sh
set -Eeuo pipefail

INPUT_DIR="${1:?input dir}"
WORK_DIR="${2:?work dir}"
BUILD_ID="${3:-build-$(date +%s)}"
REPO="${GH_REPO:?GH_REPO}"

LOG="$WORK_DIR/build.log"
OUT="$WORK_DIR/out"
LOGS="$WORK_DIR/logs"
PHASE=0
LAST_LINE=0

mkdir -p "$WORK_DIR" "$OUT" "$LOGS"
: > "$LOG"

say()  { printf '%s\n' "$*" | tee -a "$LOG"; }
fail() { say "BUILD FAILED: $*"; gh release upload "build-$BUILD_ID" "$LOG#build.log" --clobber --repo "$REPO" 2>/dev/null || true; exit 1; }

upload_phase() {
  PHASE=$((PHASE + 1))
  local slice="$LOGS/log-$PHASE.txt"
  awk -v prev="$LAST_LINE" 'NR > prev' "$LOG" > "$slice"
  LAST_LINE=$(wc -l < "$LOG")
  gh release upload "build-$BUILD_ID" "$slice#log-$PHASE.txt" --clobber --repo "$REPO" 2>/dev/null || true
}

say "[prepare] membaca meta.json"
python3 scripts/prepare.py "$INPUT_DIR/meta.json" "$WORK_DIR" 2>&1 | tee -a "$LOG" || fail "prepare.py"
upload_phase

META="$INPUT_DIR/meta.json"
FW=$(jq -r '.meta.framework // "Android native (Gradle)"' "$META")
TYPE=$(jq -r '.meta.type // "debug"' "$META")
FMT=$(jq -r '.meta.fmt // "apk"' "$META")
GARGS=$(jq -r '.meta.options.gradleArgs // ""' "$META")
OFFLINE=$(jq -r '.meta.options.offline // false' "$META")
CLEAN=$(jq -r '.meta.options.clean // false' "$META")
CACHE=$(jq -r '.meta.options.cache // true' "$META")
TMO=$(jq -r '.meta.options.timeoutMin // 120' "$META")

[ -f "$WORK_DIR/env.sh" ] && . "$WORK_DIR/env.sh"

TMO_SEC=$((TMO * 60))
run_to() { timeout --signal=TERM --kill-after=30 "$TMO_SEC" "$@" 2>&1 | tee -a "$LOG"; return "${PIPESTATUS[0]}"; }

CACHE_ARGS=()
[ "$CACHE" = "false" ] && CACHE_ARGS+=("--no-build-cache")

PROJ="$WORK_DIR/project"
cd "$PROJ"

case "$FW" in
  Flutter)
    say "[deps] flutter pub get"
    run_to flutter pub get || fail "flutter pub get"
    upload_phase
    ;;

  "React Native"|"Capacitor / Ionic"|"Cordova")
    say "[deps] npm install"
    if [ -f package-lock.json ]; then run_to npm ci --no-audit --no-fund || fail "npm ci"
    else run_to npm install --no-audit --no-fund || fail "npm install"; fi
    upload_phase

    if [ "$FW" = "Capacitor / Ionic" ]; then
      say "[deps] npx cap sync android"
      run_to npx --yes cap sync android || fail "cap sync"
      cd android
    elif [ "$FW" = "Cordova" ]; then
      say "[deps] cordova prepare android"
      run_to npx --yes cordova prepare android || fail "cordova prepare"
      cd platforms/android
    else
      cd android
    fi
    upload_phase
    ;;
esac

case "$FW" in
  Flutter)
    if [ "$FMT" = "aab" ]; then
      say "[build] flutter build appbundle --release"
      run_to flutter build appbundle --release || fail "appbundle"
    elif [ "$TYPE" = "release" ]; then
      say "[build] flutter build apk --release"
      run_to flutter build apk --release || fail "apk release"
    else
      say "[build] flutter build apk --debug"
      run_to flutter build apk --debug || fail "apk debug"
    fi
    ;;
  *)
    G=./gradlew
    [ -x "$G" ] || G=gradle
    [ "$CLEAN" = "true" ] && { say "[build] clean"; run_to "$G" clean --no-daemon || true; }
    TASK="assembleDebug"
    [ "$TYPE" = "release" ] && TASK="assembleRelease"
    [ "$FMT" = "aab" ] && { [ "$TYPE" = "release" ] && TASK="bundleRelease" || TASK="bundleDebug"; }
    ARGS=(--no-daemon --stacktrace --console=plain -Dorg.gradle.workers.max=2)
    [ "$OFFLINE" = "true" ] && ARGS+=(--offline)
    ARGS+=("${CACHE_ARGS[@]}")
    say "[build] $G $TASK ${ARGS[*]} $GARGS"
    # shellcheck disable=SC2086
    run_to "$G" "$TASK" "${ARGS[@]}" $GARGS || fail "gradle $TASK"
    ;;
esac
upload_phase

say "[collect] mengumpulkan outputs"
idx=0
while IFS= read -r -d '' f; do
  base=$(basename "$f")
  if [ -n "${OUT_NAME:-}" ]; then
    ext="${f##*.}"
    if [ "$idx" -eq 0 ]; then dst="$OUT_NAME"; else dst="${OUT_NAME%.*}-$idx.${ext}"; fi
    case "$dst" in *."$ext") ;; *) dst="$dst.$ext" ;; esac
    cp -v "$f" "$OUT/$dst" | tee -a "$LOG"
  else
    cp -v "$f" "$OUT/$base" | tee -a "$LOG"
  fi
  idx=$((idx + 1))
done < <(find "$PROJ" -type f \( -name '*.apk' -o -name '*.aab' \) -path '*/outputs/*' -print0 2>/dev/null)

find "$PROJ" -type f -name 'mapping.txt' -print0 2>/dev/null \
  | while IFS= read -r -d '' f; do cp -v "$f" "$OUT/mapping.txt" | tee -a "$LOG"; done

cp -f "$LOG" "$OUT/build.log" 2>/dev/null || true

COUNT=$(find "$OUT" -maxdepth 1 -type f \( -name '*.apk' -o -name '*.aab' \) | wc -l)
[ "$COUNT" -gt 0 ] || fail "tidak ada APK/AAB di outputs"
upload_phase

say "[upload] mengunggah $COUNT paket ke release build-$BUILD_ID"
n=0
while IFS= read -r -d '' f; do
  n=$((n + 1))
  ext="${f##*.}"
  if [ "$n" -eq 1 ]; then name="app.$ext"; else name="app-$n.$ext"; fi
  gh release upload "build-$BUILD_ID" "$f#$name" --clobber --repo "$REPO"
done < <(find "$OUT" -maxdepth 1 -type f \( -name '*.apk' -o -name '*.aab' \) -print0)

gh release upload "build-$BUILD_ID" "$LOG#build.log" --clobber --repo "$REPO" || true
[ -f "$OUT/mapping.txt" ] && gh release upload "build-$BUILD_ID" "$OUT/mapping.txt#mapping.txt" --clobber --repo "$REPO" || true

say "[done] sukses — $COUNT paket di release build-$BUILD_ID"
