#!/bin/zsh
# Real-browser walk of Solutions Builder through all nine stages against a
# local OpenAI-compatible model. See scripts/WALK-BROWSER.md for usage.
#
# Boots an isolated host (fresh temp data dir, OS-assigned free port), signs
# up a throwaway account, connects the model, creates a project from
# WALK_BRIEF, and drives stages 1-9 through agent-browser, writing compact
# walk.jsonl / defects.jsonl records to WALK_OUT_DIR. On a blocker it
# screenshots, records the defect, and exits non-zero without faking progress.
set -u
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

WALK_MODEL_BASE_URL=${WALK_MODEL_BASE_URL:-https://thegreataxios-home-studio.tail87f5aa.ts.net/v1}
WALK_MODEL_API_KEY=${WALK_MODEL_API_KEY:-ollama}
WALK_MODEL=${WALK_MODEL:-gpt-oss:20b}
WALK_BRIEF=${WALK_BRIEF:-scripts/walk-browser-brief.md}
WALK_RESUME_STAGE=${WALK_RESUME_STAGE:-0}
WALK_END_STAGE=${WALK_END_STAGE:-9}
WALK_STAGE_TIMEOUT_S=${WALK_STAGE_TIMEOUT_S:-900}
# Stage 8 runs a real coding agent against a local model: give it far more
# room than the other stages' conversational turns. Configurable because a
# slower local model may need longer still.
WALK_STAGE8_TIMEOUT_S=${WALK_STAGE8_TIMEOUT_S:-2400}
WALK_OUT_DIR=${WALK_OUT_DIR:-$(mktemp -d /tmp/walk-browser-XXXXXX)}
WALK_KEEP_HOST=${WALK_KEEP_HOST:-}

mkdir -p "$WALK_OUT_DIR/shots"
WALK_JSONL="$WALK_OUT_DIR/walk.jsonl"
DEFECTS_JSONL="$WALK_OUT_DIR/defects.jsonl"
: > "$WALK_JSONL"
: > "$DEFECTS_JSONL"

SESSION="walk-browser-$$"
HOST_DATA_DIR=""
HOST_PID=""
STAGE="boot"

json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1" 2>/dev/null || printf '"%s"' "$(echo "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

now_ms() { python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || echo $(( $(date +%s) * 1000 )); }

walk_log() { # stage action outcome ms
  local s="$1" a="$2" o="$3" ms="$4"
  printf '{"stage":%s,"action":%s,"outcome":%s,"ms":%s}\n' "$(json_escape "$s")" "$(json_escape "$a")" "$(json_escape "$o")" "$ms" >> "$WALK_JSONL"
  echo "$(date -u +%H:%M:%S) [$s] $a -> $o (${ms}ms)"
}

defect_log() { # stage expected observed screenshot severity
  local s="$1" exp="$2" obs="$3" shot="$4" sev="$5"
  printf '{"stage":%s,"expected":%s,"observed":%s,"screenshot":%s,"severity":%s}\n' \
    "$(json_escape "$s")" "$(json_escape "$exp")" "$(json_escape "$obs")" "$(json_escape "$shot")" "$(json_escape "$sev")" >> "$DEFECTS_JSONL"
  echo "$(date -u +%H:%M:%S) DEFECT[$sev] stage $s: expected $exp, observed $obs ($shot)"
}

ab() { agent-browser --session "$SESSION" "$@"; }
SNAP="$WALK_OUT_DIR/snap.txt"
snap() { ab snapshot -i > "$SNAP" 2>&1; }
shot() { ab screenshot "$WALK_OUT_DIR/shots/$1.png" >/dev/null 2>&1; }
# Matches `<pattern> [<any bracket content>ref=eN...` regardless of what
# other flags (disabled, expanded=false, checked=false, ...) share the
# brackets, and regardless of order.
ref() { grep -oE "$1 \[[^]]*ref=e[0-9]+" "$SNAP" | ${2:-head} -1 | grep -oE 'ref=e[0-9]+' | sed 's/ref=//'; }
enabled_ref() { grep -oE "$1 \[[^]]*ref=e[0-9]+" "$SNAP" | grep -v 'disabled' | ${2:-head} -1 | grep -oE 'ref=e[0-9]+' | sed 's/ref=//'; }
badge() { grep -oE 'Decision queue [0-9]+' "$SNAP" | head -1 | awk '{print $3}'; }
replies() { grep -cE 'article "[^"]* replied"' "$SNAP"; }

wait_for() { # regex seconds
  local t0=$(date +%s)
  while true; do
    snap
    grep -qE "$1" "$SNAP" && return 0
    [ $(( $(date +%s) - t0 )) -ge "$2" ] && return 1
    sleep 5
  done
}
wait_reply() { # min_count
  local t0=$(date +%s)
  while true; do
    snap
    [ "$(replies)" -gt "$1" ] && return 0
    [ $(( $(date +%s) - t0 )) -ge "$WALK_STAGE_TIMEOUT_S" ] && return 1
    sleep 5
  done
}

send_message() {
  snap
  local tb=$(ref 'textbox "Message"' tail)
  [ -z "$tb" ] && { defect_log "$STAGE" "a Message composer" "no Message textbox found" "" "blocker"; return 1; }
  ab fill "@$tb" "$1" >/dev/null 2>&1; sleep 1; snap
  local sb=$(enabled_ref 'button "Send message"' tail)
  if [ -n "$sb" ]; then ab click "@$sb" >/dev/null 2>&1; else ab click "@$tb" >/dev/null 2>&1; ab press Enter >/dev/null 2>&1; fi
  sleep 3
  return 0
}

open_project() { ab click "text=$PROJECT_TITLE" >/dev/null 2>&1; sleep 2; }

# Stage 3 is a choice before it is an approval: while the document still
# offers approaches, pick the first one, wait for the specialist to rewrite it
# with the choice on top, and only then is there an Approve to click.
choose_approach() {
  snap
  grep -q 'Neither, redraft' "$SNAP" || return 0
  local before=$(replies)
  # The interactive snapshot lists controls only, so the "Which approach?"
  # label is not in it: the approaches are the run of buttons directly above
  # "Neither, redraft", and the first of that run is the one to pick.
  local pick=$(awk '
    /- button "/ && !/disabled/ { if (!run) start=$0; run=1; if (/Neither, redraft/) { print start; exit } ; next }
    { run=0 }' "$SNAP" | grep -v 'Neither, redraft' | grep -oE 'ref=e[0-9]+' | sed 's/ref=//')
  if [ -z "$pick" ]; then
    shot "no-approach-choice"
    defect_log 3 "an approach to choose" "the choice row offered no enabled approach" "shots/no-approach-choice.png" "blocker"
    return 1
  fi
  ab click "@$pick" >/dev/null
  walk_log 3 "choose approach" "picked the first offered approach" 0
  if ! wait_reply "$before"; then
    shot "no-rewrite-after-choice"
    defect_log 3 "the document rewritten with the chosen approach" "no reply within ${WALK_STAGE_TIMEOUT_S}s" "shots/no-rewrite-after-choice.png" "blocker"
    return 1
  fi
  if ! wait_for 'button "Approve and continue" \[ref=' 60; then
    shot "still-choosing-stage-3"
    defect_log 3 "an Approve row after the choice was written up" "the page still asks which approach" "shots/still-choosing-stage-3.png" "major"
    return 1
  fi
  return 0
}

approve_stage() { # stage_number
  snap
  local a=$(awk -v s="Stage $1 of 9 ·" 'index($0,s){f=1} f && /button "Approve and continue" \[ref=/{match($0,/ref=e[0-9]+/); print substr($0,RSTART+4,RLENGTH-4); exit}' "$SNAP")
  [ -z "$a" ] && a=$(grep -E '^ *- button "Approve and continue" \[ref=' "$SNAP" | head -1 | grep -oE 'ref=e[0-9]+' | sed 's/ref=//')
  if [ -z "$a" ]; then
    shot "no-approve-stage-$1"
    defect_log "$1" "an enabled Approve and continue button" "none found" "shots/no-approve-stage-$1.png" "blocker"
    return 1
  fi
  ab click "@$a" >/dev/null
  local n=$(( $1 + 1 ))
  if ! wait_for "Stage $n of 9" 90; then
    shot "no-advance-stage-$1"
    defect_log "$1" "advance to stage $n after approval" "still on stage $1" "shots/no-advance-stage-$1.png" "blocker"
    return 1
  fi
  return 0
}

cleanup() {
  local exit_code=$?
  echo "cleaning up..."
  # Failed requests are how a swallowed deploy error shows up; keep them with the run.
  ab network requests --status 400-599 > "$WALK_OUT_DIR/failed-requests.txt" 2>&1
  ab errors > "$WALK_OUT_DIR/page-errors.txt" 2>&1
  ab close >/dev/null 2>&1
  if [ -z "$WALK_KEEP_HOST" ]; then
    [ -n "$HOST_PID" ] && kill "$HOST_PID" >/dev/null 2>&1
    sleep 1
    [ -n "$HOST_PID" ] && kill -9 "$HOST_PID" >/dev/null 2>&1
    [ -n "$HOST_DATA_DIR" ] && rm -rf "$HOST_DATA_DIR"
  fi
  if pgrep -f "apps/hub/src/server.ts.*$HOST_DATA_DIR" >/dev/null 2>&1; then
    echo "WARNING: a host process for this run's data dir is still alive"
  fi
  exit $exit_code
}
trap cleanup EXIT INT TERM

# --- boot ---
T0=$(date +%s)
HOST_DATA_DIR=$(mktemp -d /tmp/walk-browser-host-XXXXXX)
export WALK_HOST_DATA_DIR="$HOST_DATA_DIR"
HOST_LOG=$(mktemp /tmp/walk-browser-host-log-XXXXXX)
export WALK_HOST_LOG="${WALK_HOST_LOG:-$WALK_OUT_DIR/host.log}"
bun --conditions intx-src scripts/walk-browser-host.ts > "$HOST_LOG" 2>>"$HOST_LOG" &
HOST_PID=$!
HOST_URL=""
for _ in $(seq 1 60); do
  HOST_URL=$(grep -oE 'HOST_URL .*' "$HOST_LOG" | head -1 | sed 's/HOST_URL //')
  [ -n "$HOST_URL" ] && break
  kill -0 "$HOST_PID" 2>/dev/null || break
  sleep 2
done
if [ -z "$HOST_URL" ]; then
  walk_log boot "start host" "FAIL: host did not print a launch URL" $(( ($(date +%s)-T0)*1000 ))
  echo "host log (masked review needed before sharing):"
  sed -E 's/token=[a-f0-9-]+/token=***/' "$HOST_LOG"
  exit 1
fi
walk_log boot "start host" "OK (masked url, port from $(echo "$HOST_URL" | sed -E 's#.*127.0.0.1:([0-9]+).*#\1#'))" $(( ($(date +%s)-T0)*1000 ))
HOST_ORIGIN=$(echo "$HOST_URL" | sed -E 's#(http://127.0.0.1:[0-9]+)/.*#\1#')

if [ -n "$WALK_KEEP_HOST" ]; then
  echo "WALK_KEEP_HOST=1: host origin is $HOST_ORIGIN (token withheld from this line)"
fi

# --- browser session ---
export AGENT_BROWSER_SESSION="$SESSION"
ab open "$HOST_URL" >/dev/null 2>&1
sleep 3

# An embedded hub mints its owner automatically — there is no sign-up form.
# The first screen is onboarding's Welcome step; "Skip setup" jumps straight
# to the provider step, which is the only onboarding surface the walk needs.
STAGE="signup"
T0=$(date +%s)
if ! wait_for 'button "(Get started|Skip setup)"' 60; then
  shot "no-onboarding"
  defect_log signup "the onboarding welcome step (embedded hubs mint the owner)" "neither Get started nor Skip setup found" "shots/no-onboarding.png" "blocker"
  exit 1
fi
snap
SKIP_SETUP=$(ref 'button "Skip setup"')
[ -n "$SKIP_SETUP" ] && ab click "@$SKIP_SETUP" >/dev/null
walk_log signup "owner mint" "embedded owner minted; skipped welcome to provider step" $(( ($(date +%s)-T0)*1000 ))

STAGE="provider"
T0=$(date +%s)
if ! wait_for 'Connect a provider' 30; then
  shot "no-onboarding-provider-step"
  defect_log provider "the provider-connect onboarding step" "did not appear after sign-up" "shots/no-onboarding-provider-step.png" "blocker"
  exit 1
fi
snap
# The provider step is a list of rows, one per candidate; the
# OpenAI-compatible endpoint is the last "Connect API key" row, and clicking
# it expands an Endpoint field, a key field and a Save button in place.
COMPAT=$(ref 'button "Connect API key"' tail)
if [ -z "$COMPAT" ]; then
  shot "no-provider-row"
  defect_log provider "an OpenAI-compatible endpoint row" "no Connect API key row found" "shots/no-provider-row.png" "blocker"
  exit 1
fi
ab click "@$COMPAT" >/dev/null
sleep 1; snap
BASE_FIELD=$(ref 'textbox "Endpoint"')
if [ -z "$BASE_FIELD" ]; then
  shot "no-provider-form"
  defect_log provider "a base-URL field for a compatible endpoint" "field not found" "shots/no-provider-form.png" "blocker"
  exit 1
fi
ab fill "@$BASE_FIELD" "$WALK_MODEL_BASE_URL" >/dev/null
KEY_FIELD=$(ref 'textbox "OpenAI-compatible endpoint API key"')
[ -z "$KEY_FIELD" ] && KEY_FIELD=$(ref 'textbox' tail)
ab fill "@$KEY_FIELD" "$WALK_MODEL_API_KEY" >/dev/null 2>&1
snap
SAVE=$(enabled_ref 'button "Save"')
[ -n "$SAVE" ] && ab click "@$SAVE" >/dev/null
# A fresh connection that offers a real model choice lands on the model step
# before the project step; take the recommended row and move on.
if ! wait_for 'Which model should it draft with|What problem are you trying to solve' 90; then
  shot "provider-connect-failed"
  defect_log provider "advance past the provider step after connecting" "still on the provider step" "shots/provider-connect-failed.png" "major"
  exit 1
fi
snap
if grep -q 'Which model should it draft with' "$SNAP"; then
  PICK=$(ref 'button "[^"]*Recommended')
  [ -z "$PICK" ] && PICK=$(ref 'button "[^"]*Default"')
  [ -n "$PICK" ] && ab click "@$PICK" >/dev/null
  walk_log provider "select model" "picked the recommended model row" 0
  if ! wait_for 'What problem are you trying to solve' 60; then
    shot "model-choice-stuck"
    defect_log provider "advance to the project step after choosing a model" "still on the model step" "shots/model-choice-stuck.png" "major"
    exit 1
  fi
fi
walk_log provider "connect model" "connected $WALK_MODEL_BASE_URL" $(( ($(date +%s)-T0)*1000 ))

STAGE="create-project"
T0=$(date +%s)
BRIEF_TEXT=$(cat "$WALK_BRIEF")
PROJECT_TITLE=$(echo "$BRIEF_TEXT" | head -c 40 | tr -d '\n')
snap
PROBLEM_FIELD=$(ref '#first-problem')
[ -z "$PROBLEM_FIELD" ] && PROBLEM_FIELD=$(ref 'textbox')
ab fill "@$PROBLEM_FIELD" "$BRIEF_TEXT" >/dev/null
sleep 1; snap
BEGIN=$(enabled_ref 'button "Begin problem discovery"')
if [ -z "$BEGIN" ]; then
  shot "no-begin-button"
  defect_log create-project "an enabled Begin problem discovery button" "button disabled or missing" "shots/no-begin-button.png" "blocker"
  exit 1
fi
ab click "@$BEGIN" >/dev/null
if ! wait_for "Stage 1 of 9" 120; then
  shot "project-not-created"
  defect_log create-project "the project workspace at Stage 1 of 9" "did not open within 120s" "shots/project-not-created.png" "blocker"
  exit 1
fi
walk_log create-project "create project" "opened at stage 1" $(( ($(date +%s)-T0)*1000 ))

# The app uses the first model the endpoint lists unless one is selected.
# Stage 1 is already deployed; every later stage deploys with this choice.
PROJECT_URL=$(ab get url 2>/dev/null | tail -1)
snap
SETTINGS=$(ref 'link "Settings"'); [ -z "$SETTINGS" ] && SETTINGS=$(ref 'button "Settings"')
[ -n "$SETTINGS" ] && ab click "@$SETTINGS" >/dev/null
if wait_for 'combobox "Model for ' 30; then
  ab select "@$(ref 'combobox "Model for [^"]*"')" "$WALK_MODEL" >/dev/null; sleep 3
  walk_log provider "select model" "$WALK_MODEL" 0
else
  shot "no-model-picker"; defect_log provider "a model picker in Settings" "not found" "shots/no-model-picker.png" "major"
fi
ab open "$PROJECT_URL" >/dev/null 2>&1
wait_for 'button "Open" \[ref=' 30 && ab click "@$(ref 'button "Open"')" >/dev/null
if ! wait_for "Stage 1 of 9" 60; then
  shot "no-return-to-project"; defect_log provider "return to the project" "not found" "shots/no-return-to-project.png" "blocker"; exit 1
fi

STAGES=$(seq $([ "$WALK_RESUME_STAGE" -gt 0 ] 2>/dev/null && echo "$WALK_RESUME_STAGE" || echo 1) "$WALK_END_STAGE")

for STAGE in $(echo $STAGES); do
  T0=$(date +%s)
  case $STAGE in
    1|2|3|6)
      if ! wait_reply 0; then defect_log "$STAGE" "a specialist reply" "none within ${WALK_STAGE_TIMEOUT_S}s" "" "blocker"; exit 1; fi
      if [ "$STAGE" -eq 1 ]; then
        send_message "Assume a small team, one approver, and keep the scope to a first version."
        wait_reply 1 || { defect_log 1 "a second specialist reply" "none within ${WALK_STAGE_TIMEOUT_S}s" "" "blocker"; exit 1; }
      fi
      if [ "$STAGE" -eq 3 ]; then choose_approach || exit 1; fi
      approve_stage "$STAGE" || exit 1 ;;
    4)
      if ! wait_for 'button "Approve and continue" \[ref=' "$WALK_STAGE_TIMEOUT_S"; then
        shot "timeout-stage-4"; defect_log 4 "the design panel to become approvable" "timed out" "shots/timeout-stage-4.png" "blocker"; exit 1
      fi
      approve_stage 4 || exit 1 ;;
    5)
      if ! wait_for 'button "Write it"' 120; then
        shot "stage-5-no-write-it"; defect_log 5 "a Write it button per stakeholder" "not found" "shots/stage-5-no-write-it.png" "blocker"; exit 1
      fi
      w=$(enabled_ref 'button "Write it"'); ab click "@$w" >/dev/null
      if ! wait_for 'button "Proceed"' "$WALK_STAGE_TIMEOUT_S"; then
        shot "timeout-stage-5"; defect_log 5 "a Proceed button after the package is written" "timed out" "shots/timeout-stage-5.png" "blocker"; exit 1
      fi
      tb=$(ref 'textbox "Why this decision"'); [ -n "$tb" ] && ab fill "@$tb" "Scope is right for a first version." >/dev/null
      pr=$(enabled_ref 'button "Proceed"'); ab click "@$pr" >/dev/null; sleep 3
      if ! wait_for '^ *- button "Approve and continue" \[ref=' 90; then
        shot "stage-5-no-approve"; defect_log 5 "Approve to enable after quorum" "still disabled" "shots/stage-5-no-approve.png" "major"; exit 1
      fi
      approve_stage 5 || exit 1 ;;
    7)
      if ! wait_reply 0; then defect_log 7 "a specialist reply" "none within ${WALK_STAGE_TIMEOUT_S}s" "" "blocker"; exit 1; fi
      snap
      r=$(grep -oE 'radio "[^"]*" \[checked=false, ref=e[0-9]+' "$SNAP" | head -1 | sed 's/.*ref=//')
      if [ -z "$r" ]; then
        shot "stage-7-no-target"; defect_log 7 "a selectable target radio" "none found" "shots/stage-7-no-target.png" "major"; exit 1
      fi
      ab click "@$r" >/dev/null; sleep 1
      approve_stage 7 || exit 1 ;;
    8)
      if ! wait_for 'button "Start the build attempt" \[ref=' 180; then
        shot "stage-8-no-panel"; defect_log 8 "the build panel with Start the build attempt" "did not appear" "shots/stage-8-no-panel.png" "blocker"; exit 1
      fi
      st=$(enabled_ref 'button "Start the build attempt"'); [ -n "$st" ] && ab click "@$st" >/dev/null
      # A standing "Allow for this build" grant covers every later run_shell
      # call on this same run (verified in
      # vendor/interchange/packages/hub-api/src/routes/approvals.ts's
      # resolveApproval: scope "always" sets this run's grant for the exact
      # tool name to allow), so one click here is enough for the whole
      # attempt -- never click a blind "Approve" on a reply with no evidence.
      granted=0
      t1=$(date +%s)
      while true; do
        snap
        if [ "$granted" -eq 0 ]; then
          allow=$(enabled_ref 'button "Allow for this build"')
          if [ -n "$allow" ]; then
            ab click "@$allow" >/dev/null; sleep 2
            granted=1
            walk_log 8 "grant permission" "clicked Allow for this build (standing run_shell grant on this run)" $(( ($(date +%s)-t1)*1000 ))
          fi
        fi
        grep -qE '^ *- button "Approve and continue" \[ref=' "$SNAP" && break
        if [ $(( $(date +%s) - T0 )) -ge "$WALK_STAGE8_TIMEOUT_S" ]; then
          shot "timeout-stage-8-build"
          defect_log 8 "a published build archive (Approve and continue enabled by evidence)" "timed out after ${WALK_STAGE8_TIMEOUT_S}s (permission granted=$granted)" "shots/timeout-stage-8-build.png" "blocker"
          exit 1
        fi
        sleep 5
      done
      shot "stage-8"
      approve_stage 8 || exit 1 ;;
    9)
      if ! wait_reply 0; then defect_log 9 "a specialist reply" "none within ${WALK_STAGE_TIMEOUT_S}s" "" "blocker"; exit 1; fi
      nudged=0; t1=$(date +%s)
      while true; do
        snap
        accept=$(enabled_ref 'button "Accept the delivery"')
        if [ -n "$accept" ]; then
          ab click "@$accept" >/dev/null; sleep 3; snap
          break
        fi
        if [ "$nudged" -eq 0 ] && [ $(( $(date +%s) - t1 )) -ge 60 ]; then
          nudged=1
          send_message "Submit the delivery now by calling the deliver tool with manifestNodeId, a one-paragraph summary, and artifacts [{path, contentHash}] for every file you created."
        fi
        if [ $(( $(date +%s) - t1 )) -ge "$WALK_STAGE_TIMEOUT_S" ]; then
          shot "timeout-stage-9"; defect_log 9 "a deliver approval to accept" "timed out" "shots/timeout-stage-9.png" "blocker"; exit 1
        fi
        sleep 5
      done
      shot "stage-9-done"

      # Final check: download the delivered archive and unpack it. A stage 8
      # that produced no real archive must fail loudly here, not pass on the
      # strength of a specialist's say-so.
      snap
      dl=$(enabled_ref 'button "Download the build')
      if [ -z "$dl" ]; then
        shot "stage-9-no-download"
        defect_log 9 "a Download the build button after acceptance" "not found" "shots/stage-9-no-download.png" "blocker"
        exit 1
      fi
      ARCHIVE_PATH="$WALK_OUT_DIR/delivered-build.tar.gz"
      ab download "@$dl" "$ARCHIVE_PATH" >/dev/null 2>&1
      if [ ! -s "$ARCHIVE_PATH" ]; then
        shot "stage-9-download-empty"
        defect_log 9 "a non-empty downloaded archive" "download missing or empty" "shots/stage-9-download-empty.png" "blocker"
        exit 1
      fi
      UNPACK_DIR="$WALK_OUT_DIR/unpacked"
      mkdir -p "$UNPACK_DIR"
      tar -xzf "$ARCHIVE_PATH" -C "$UNPACK_DIR" 2>/dev/null
      find "$UNPACK_DIR" > "$WALK_OUT_DIR/unpacked-tree.txt"
      HAS_PACKAGE_JSON=$(find "$UNPACK_DIR" -name package.json | head -1)
      HAS_SOURCE=$(find "$UNPACK_DIR" \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.py' \) | head -1)
      walk_log 9 "verify archive" "package.json=$([ -n "$HAS_PACKAGE_JSON" ] && echo yes || echo no) source=$([ -n "$HAS_SOURCE" ] && echo yes || echo no) tree=$WALK_OUT_DIR/unpacked-tree.txt" 0
      if [ -z "$HAS_PACKAGE_JSON" ] || [ -z "$HAS_SOURCE" ]; then
        shot "stage-9-hollow-archive"
        defect_log 9 "package.json and source files in the delivered archive" "package.json=$([ -n "$HAS_PACKAGE_JSON" ] && echo found || echo missing) source=$([ -n "$HAS_SOURCE" ] && echo found || echo missing)" "shots/stage-9-hollow-archive.png" "blocker"
        exit 1
      fi
      ;;
  esac
  walk_log "$STAGE" "complete stage" "advanced" $(( ($(date +%s)-T0)*1000 ))
  [ "$STAGE" -eq "$WALK_END_STAGE" ] && [ "$STAGE" -lt 9 ] && { walk_log "$STAGE" "stop" "WALK_END_STAGE reached" 0; break; }
done

walk_log done "walk complete" "reached stage $STAGE" $(( ($(date +%s)-T0)*1000 ))
echo "walk.jsonl: $WALK_JSONL"
echo "defects.jsonl: $DEFECTS_JSONL"
