/**
 * The relay's installer, served at /relay/install.sh. One command on any
 * always-on Linux machine (an Oracle free VM will do):
 *
 *   curl -fsSL https://<worker>/relay/install.sh | RELAY_TOKEN=relay_… bash
 *
 * Run again without RELAY_TOKEN, it updates the relay and keeps its token.
 * It installs curl, jq and Claude Code if missing — with RELAY_CODEX=1, the
 * Codex CLI instead (from npm) — writes ~/.tg-relay/relay.sh and a systemd
 * service running it as the current user, and starts it. The relay only asks
 * the Worker for work, so it needs no open port, domain or public address.
 * Claude Code must be signed in once on that machine (`claude`, then /login)
 * — the relay writes to sessions as that account; Codex likewise (`codex
 * login`), and connected to the bot (`codex mcp add`, `codex mcp login`).
 *
 * The relay says which of the two it has, and runs each job by its runner:
 * Claude's in turn, Codex's in the background — a few at a time, one per
 * session — while it keeps asking for work, which keeps it online.
 *
 * The shell's own `${…}` would clash with the template, so the scripts do
 * without it (where it must, it is spelled ${"$"}{…}).
 */

const RELAY_LOOP = String.raw`#!/usr/bin/env bash
# Passes messages from the Telegram bot into Claude Code cloud sessions, and runs Codex here.
set -uo pipefail
API="$RELAY_ORIGIN/relay"
DIR="$HOME/.tg-relay"
# The token goes to curl from a file, never on its command line, where ps would show it.
AUTH=$(umask 077 && mktemp)
trap 'rm -f "$AUTH"' EXIT
printf 'Authorization: Bearer %s\n' "$RELAY_TOKEN" >"$AUTH"

report() { # job id, JSON[, path after the id]
  printf '%s' "$2" | curl -fsS --max-time 30 -X POST -H @"$AUTH" -H 'Content-Type: application/json' --data-binary @- "$API/jobs/$1${"$"}{3:-}" >/dev/null || true
}

# A message into a Claude Code cloud session.
claude_continue() { # job JSON
  local job=$1 id session err out code result
  id=$(printf '%s' "$job" | jq -r .id)
  session=$(printf '%s' "$job" | jq -r .session)
  err=$(mktemp)
  out=$(printf '%s' "$job" | jq -r .text | timeout 300 claude -p --cloud "$session" --output-format json 2>"$err")
  code=$?
  if [ "$code" -eq 0 ] && [ "$(printf '%s' "$out" | jq -rs '.[0].ok // false' 2>/dev/null)" = "true" ]; then
    result='{"ok":true}'
  else
    [ "$code" -eq 124 ] && echo "timed out after 300 s" >>"$err"
    result=$(jq -cn --arg out "$out" --arg err "$(cat "$err")" --arg code "$code" \
      '{ok:false, error:((($out|fromjson?).error) // (($err + " " + $out) | if test("^\\s*$") then "claude exited with " + $code else . end))}')
  fi
  rm -f "$err"
  report "$id" "$result"
  echo "$(date -u +%FT%TZ) $id -> $session: $result"
}

# A Codex thread started or carried on here; run in the background, one at a time per session.
# Sandboxed: read-only, in an empty directory. Otherwise it has the machine, from the job's directory.
CODEX_MAX=3
codex_run() { # job JSON
  local job=$1 id runner session thread model sandbox cwd out err pid code told= msg result
  id=$(printf '%s' "$job" | jq -r .id)
  runner=$(printf '%s' "$job" | jq -r .runner)
  session=$(printf '%s' "$job" | jq -r .session)
  thread=$(printf '%s' "$job" | jq -r '.thread // empty')
  model=$(printf '%s' "$job" | jq -r '.model // empty')
  sandbox=$(printf '%s' "$job" | jq -r '.sandbox // empty')
  cwd=$(printf '%s' "$job" | jq -r '.cwd // empty')
  if [ "$sandbox" = danger-full-access ]; then
    case "$cwd" in
      "" | "~") cwd=$HOME ;;
      "~/"*) cwd="$HOME/$(printf '%s' "$cwd" | cut -c3-)" ;;
    esac
  else
    sandbox=read-only
    cwd="$DIR/sandbox"
  fi
  if [ ! -d "$cwd" ]; then
    report "$id" "$(jq -cn --arg d "$cwd" '{ok:false, error:("no such directory: " + $d)}')"
    return
  fi
  exec 9>"$DIR/locks/$session"
  flock 9
  local args=(--json --skip-git-repo-check -c 'approval_policy="never"' -c "sandbox_mode=\"$sandbox\"")
  [ -n "$model" ] && args+=(-m "$model")
  # The bot's tools go without asking, once Codex is connected to the bot.
  codex mcp get telegram >/dev/null 2>&1 && args+=(-c 'mcp_servers.telegram.default_tools_approval_mode="approve"')
  out=$(mktemp)
  err=$(mktemp)
  if [ "$runner" = codex-start ]; then
    printf '%s' "$job" | jq -r .text | (cd "$cwd" && exec timeout 3000 codex exec "${"$"}{args[@]}" -C "$cwd" -) >"$out" 2>"$err" &
  else
    printf '%s' "$job" | jq -r .text | (cd "$cwd" && exec timeout 3000 codex exec resume "${"$"}{args[@]}" "$thread" -) >"$out" 2>"$err" &
  fi
  pid=$!
  # The thread's id comes first: the bot holds messages for it until it has it.
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$runner" = codex-start ] && [ -z "$told" ]; then
      thread=$(jq -rR 'fromjson? | select(.type == "thread.started") | .thread_id' "$out" 2>/dev/null | head -n 1)
      if [ -n "$thread" ]; then
        told=1
        report "$id" "$(jq -cn --arg t "$thread" '{thread:$t}')" /started
      fi
    fi
    sleep 2
  done
  wait "$pid"
  code=$?
  [ -z "$thread" ] && thread=$(jq -rR 'fromjson? | select(.type == "thread.started") | .thread_id' "$out" 2>/dev/null | head -n 1)
  if [ "$code" -eq 0 ] && grep -q '"type":"turn.completed"' "$out"; then
    result=$(jq -cn --arg t "$thread" '{ok:true, thread:$t}')
  else
    [ "$code" -eq 124 ] && echo "timed out after 50 min" >>"$err"
    msg=$(jq -rR 'fromjson? | select(.type == "turn.failed" or .type == "error") | (.error.message // .message)' "$out" 2>/dev/null | tail -n 1)
    result=$(jq -cn --arg m "$msg" --arg err "$(tail -c 400 "$err")" --arg code "$code" --arg t "$thread" \
      '{ok:false, thread:$t, error:(if $m != "" then $m elif ($err | test("^\\s*$")) then "codex exited with " + $code else $err end)}')
  fi
  rm -f "$out" "$err"
  report "$id" "$result"
  echo "$(date -u +%FT%TZ) $id -> $session: $result"
}

# What this machine can run: the Worker hands out only those jobs.
RUNNERS=
command -v claude >/dev/null 2>&1 && RUNNERS=claude
command -v codex >/dev/null 2>&1 && RUNNERS="$RUNNERS,codex"
mkdir -p "$DIR/sandbox" "$DIR/locks"
START=1
while true; do
  # With as many Codex runs as it takes going, it asks for no more until one ends.
  BUSY=
  [ "$(jobs -rp | wc -l)" -ge "$CODEX_MAX" ] && BUSY=codex
  # The Worker holds the request until a job comes, up to 25 s: no busy polling, no delay.
  ASKED=$(date +%s)
  JOBS=$(curl -fsS --max-time 40 -H @"$AUTH" "$API/jobs?wait=25&start=$START&runners=$RUNNERS&busy=$BUSY") || { sleep 20; continue; }
  START=0
  COUNT=$(printf '%s' "$JOBS" | jq 'length' 2>/dev/null || echo 0)
  for ((i = 0; i < COUNT; i++)); do
    JOB=$(printf '%s' "$JOBS" | jq -c ".[$i]")
    case "$(printf '%s' "$JOB" | jq -r '.runner // "claude-continue"')" in
      claude-continue) claude_continue "$JOB" ;;
      codex-start | codex-resume) codex_run "$JOB" & ;;
      *) report "$(printf '%s' "$JOB" | jq -r .id)" '{"ok":false,"error":"this relay cannot run that job; update it"}' ;;
    esac
  done
  # An empty answer that came at once means the Worker did not wait (signed out, say): slow down.
  if ! [ "$COUNT" -gt 0 ] 2>/dev/null && [ $(($(date +%s) - ASKED)) -lt 5 ]; then sleep 10; fi
done
`;

export function installScript(origin: string): string {
  return String.raw`#!/usr/bin/env bash
# Installs the Telegram bot's relay, which passes messages into Claude Code cloud sessions and runs Codex.
# Everything is inside main, run on the last line: a download cut short runs nothing.
set -euo pipefail
main() {
ORIGIN='${origin.replaceAll("'", "")}'
# Run again without a token, it updates the relay and keeps the one it has, and whether it runs Codex.
if [ -f "$HOME/.tg-relay/env" ]; then
  [ -z "${"$"}{RELAY_TOKEN:-}" ] && RELAY_TOKEN=$(sed -n 's/^RELAY_TOKEN=//p' "$HOME/.tg-relay/env")
  [ -z "${"$"}{RELAY_CODEX:-}" ] && RELAY_CODEX=$(sed -n 's/^RELAY_CODEX=//p' "$HOME/.tg-relay/env")
fi
if [ -z "${"$"}{RELAY_TOKEN:-}" ]; then
  echo "Run it as: curl -fsSL $ORIGIN/relay/install.sh | RELAY_TOKEN=relay_... bash" >&2
  exit 1
fi
CODEX="${"$"}{RELAY_CODEX:-0}"
have() { command -v "$1" >/dev/null 2>&1; }
if ! have curl || ! have jq; then
  if have apt-get; then sudo apt-get update -qq </dev/null && sudo apt-get install -y -qq curl jq </dev/null
  elif have dnf; then sudo dnf install -y -q curl jq </dev/null
  elif have yum; then sudo yum install -y -q curl jq </dev/null
  else echo "Install curl and jq, then run this again." >&2; exit 1; fi
fi
export PATH="$HOME/.local/bin:$PATH"
if [ "$CODEX" = 1 ]; then
  if ! have codex; then
    if ! have npm; then
      echo "Codex comes from npm: install Node.js 18 or newer with npm (https://nodejs.org), then run this again." >&2
      exit 1
    fi
    npm install -g @openai/codex </dev/null || sudo npm install -g @openai/codex </dev/null
    have codex || { echo "Codex was installed but is not on PATH: add npm's global bin directory to PATH and run this again." >&2; exit 1; }
  fi
elif ! have claude; then
  curl -fsSL https://claude.ai/install.sh | bash </dev/null
fi
# The service sees only these: where claude, codex and node are, and the usual.
RUN_PATH=/usr/local/bin:/usr/bin:/bin
for tool in node codex claude; do
  if have "$tool"; then RUN_PATH="$(dirname "$(command -v "$tool")"):$RUN_PATH"; fi
done

DIR="$HOME/.tg-relay"
mkdir -p "$DIR" && chmod 700 "$DIR"
printf 'RELAY_TOKEN=%s\nRELAY_ORIGIN=%s\nRELAY_CODEX=%s\n' "$RELAY_TOKEN" "$ORIGIN" "$CODEX" >"$DIR/env"
chmod 600 "$DIR/env"
cat >"$DIR/relay.sh" <<'RELAY'
${RELAY_LOOP}RELAY
chmod 700 "$DIR/relay.sh"

sudo tee /etc/systemd/system/tg-relay.service >/dev/null <<UNIT
[Unit]
Description=Telegram bot relay to Claude Code sessions and Codex
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$HOME
EnvironmentFile=$DIR/env
Environment=PATH=$RUN_PATH
ExecStart=/bin/bash $DIR/relay.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now tg-relay >/dev/null
sudo systemctl restart tg-relay

echo
echo "The relay is running (logs: journalctl -u tg-relay -f)."
if have claude; then
  if ! claude auth status 2>/dev/null | grep -q '"loggedIn": true'; then
    echo "Now sign Claude Code in once: run claude, then /login. Then: sudo systemctl restart tg-relay"
  else
    echo "Claude Code is signed in. After any new /login, run: sudo systemctl restart tg-relay"
  fi
fi
if have codex; then
  echo
  echo "Codex, once, here:"
  echo "  codex login                (without a browser: codex login --device-auth)"
  echo "  codex mcp add telegram --url $ORIGIN/"
  echo "  codex mcp login telegram --no-browser"
  echo "  sudo systemctl restart tg-relay"
fi
}
main "$@"
`;
}
