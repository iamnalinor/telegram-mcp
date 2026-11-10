/**
 * The relay's installer, served at /relay/install.sh. One command on any
 * always-on Linux machine (an Oracle free VM will do):
 *
 *   curl -fsSL https://<worker>/relay/install.sh | RELAY_TOKEN=relay_… RELAY_AGENT=claude bash
 *
 * A relay serves one assistant, named on the first install — RELAY_AGENT=claude
 * passes messages into Claude Code cloud sessions, RELAY_AGENT=codex runs the
 * Codex CLI there — and without one it says so and stops: nothing is assumed.
 * Run again without RELAY_TOKEN or RELAY_AGENT, it updates the relay and keeps
 * the ones it has. It installs curl, jq and that assistant if missing — Claude
 * Code, or Codex (from npm) with bubblewrap for sandboxed runs — writes
 * ~/.tg-relay/relay.sh and a systemd service running it as the current user,
 * and starts it. The relay only asks the Worker for work, so it needs no open
 * port, domain or public address. The assistant must be signed in once on that
 * machine (`claude`, then /login; or `codex login`): the relay works as that
 * account. Codex needs no sign-in to the bot: each run is handed a token of its
 * own with its job, bound to its session (src/relay.ts), and gets it in an
 * environment variable — never on a command line, never in the log.
 *
 * The relay says what it runs — and `codex-sandbox` when bubblewrap works
 * there — and runs each job by its runner: Claude's in turn, Codex's in the
 * background — a few at a time, one per session — while it keeps asking for
 * work, which keeps it online.
 *
 * The shell's own `${…}` would clash with the template, so the scripts do
 * without it (where it must, it is spelled ${"$"}{…}).
 */

const RELAY_LOOP = String.raw`#!/usr/bin/env bash
# Passes messages from the Telegram bot into Claude Code cloud sessions, or runs Codex here: the one
# assistant it was installed for (RELAY_AGENT).
set -uo pipefail
API="$RELAY_ORIGIN/relay"
DIR="$HOME/.tg-relay"
# The token goes to curl from a file, never on its command line, where ps would show it.
AUTH=$(umask 077 && mktemp)
trap 'rm -f "$AUTH"' EXIT
printf 'Authorization: Bearer %s\n' "$RELAY_TOKEN" >"$AUTH"
# Then out of the environment: nothing the relay runs, Codex least of all, inherits it. The file
# stays readable to this user, and so to an unsandboxed run, which can do all this user can.
unset RELAY_TOKEN

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

# Sandboxed Codex runs go inside bubblewrap, each session in a box of its own: $DIR/sandbox/<session>,
# holding its work directory and its Codex home (threads, so a resume finds them). In there the run
# sees the system's programs and libraries, TLS roots, DNS, Node and Codex — read-only — and its box;
# not this user's home, files or keys, the relay's token among them. It keeps the network: Codex
# needs the model and the bot. It does see the Codex login, which it must use: copied in for the run
# and taken out after it (a refreshed one goes back, if it is still the same account). Codex keeps
# its own sandbox inside as a second layer when it works there, read-only; where it does not (no
# nested user namespaces), bubblewrap is the boundary and Codex runs with full access inside it.
# A machine where bubblewrap does not work cannot sandbox: the relay says so, and the bot does not
# hand it sandboxed runs. Nothing falls back to running unsandboxed.
BWRAP=$(command -v bwrap 2>/dev/null || true)
CODEX_AUTH="${"$"}{CODEX_HOME:-$HOME/.codex}/auth.json"
# Where Codex and the Node that runs it live, resolved: those are bound in, and nothing else of home.
CODEX_REAL=$(readlink -f "$(command -v codex 2>/dev/null)" 2>/dev/null || true)
BOX_BINDS=()
BOX_PATH=/usr/local/bin:/usr/bin:/bin
case "$CODEX_REAL" in
  *.js)
    BOX_BINDS+=(--ro-bind "$(dirname "$(dirname "$CODEX_REAL")")" "$(dirname "$(dirname "$CODEX_REAL")")")
    NODE_REAL=$(readlink -f "$(command -v node 2>/dev/null)" 2>/dev/null || true)
    if [ -n "$NODE_REAL" ]; then
      BOX_BINDS+=(--ro-bind "$(dirname "$(dirname "$NODE_REAL")")" "$(dirname "$(dirname "$NODE_REAL")")")
      BOX_PATH="$(dirname "$NODE_REAL"):$BOX_PATH"
    fi
    ;;
  ?*) BOX_BINDS+=(--ro-bind "$CODEX_REAL" "$CODEX_REAL") ;;
esac
# The sandbox_mode Codex keeps inside the box; empty: this machine cannot sandbox (set at the start).
BOX_INNER=

boxed() { # box directory, seconds, command…: runs it in the box; the run's token comes in on fd 3
  local box=$1 seconds=$2
  shift 2
  timeout "$seconds" "$BWRAP" --die-with-parent --new-session --unshare-pid --unshare-ipc --unshare-uts --clearenv \
    --setenv PATH "$BOX_PATH" --setenv HOME "$HOME" --setenv CODEX_HOME "$HOME/.codex" \
    --setenv LANG "${"$"}{LANG:-C.UTF-8}" \
    --ro-bind /usr /usr --ro-bind-try /bin /bin --ro-bind-try /sbin /sbin \
    --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64 --ro-bind-try /lib32 /lib32 \
    --ro-bind-try /etc/ssl /etc/ssl --ro-bind-try /etc/ca-certificates /etc/ca-certificates \
    --ro-bind-try /etc/pki /etc/pki --ro-bind-try /etc/resolv.conf /etc/resolv.conf \
    --ro-bind-try /etc/hosts /etc/hosts --ro-bind-try /etc/nsswitch.conf /etc/nsswitch.conf \
    --ro-bind "$DIR/sandbox/passwd" /etc/passwd --ro-bind "$DIR/sandbox/group" /etc/group \
    --proc /proc --dev /dev --tmpfs /tmp --tmpfs "$HOME" "${"$"}{BOX_BINDS[@]}" \
    --bind "$box/codex" "$HOME/.codex" --bind "$box/work" "$HOME/work" --chdir "$HOME/work" \
    --ro-bind-data 3 /run/tg-relay/token \
    /bin/sh -c 'TG_MCP_TOKEN=$(cat /run/tg-relay/token) && export TG_MCP_TOKEN && exec "$@"' sh "$@"
}

# Whether this machine can sandbox Codex, and how: a run of Codex in a box, then its own sandbox in it.
box_check() {
  local box="$DIR/sandbox/check"
  BOX_INNER=
  [ -n "$BWRAP" ] && [ -n "$CODEX_REAL" ] || return 0
  printf 'root:x:0:0::/root:/bin/sh\n%s:x:%s:%s::%s:/bin/sh\n' "$(id -un)" "$(id -u)" "$(id -g)" "$HOME" >"$DIR/sandbox/passwd"
  printf 'root:x:0:\n%s:x:%s:\n' "$(id -gn)" "$(id -g)" >"$DIR/sandbox/group"
  mkdir -p "$box/codex" "$box/work"
  if ! boxed "$box" 60 "$CODEX_REAL" --version </dev/null >/dev/null 2>&1 3</dev/null; then
    echo "bubblewrap does not work here: sandboxed Codex runs are refused (run the installer again to see why)" >&2
    return 0
  fi
  if boxed "$box" 60 "$CODEX_REAL" sandbox -c 'sandbox_mode="read-only"' -- /bin/true </dev/null >/dev/null 2>&1 3</dev/null; then
    BOX_INNER=read-only
  else
    BOX_INNER=danger-full-access
  fi
}

# The user's Codex login, into a box for one run, and out after it. A login the run refreshed goes
# back to the user, unless theirs changed meanwhile or it is another account: refreshing spends the
# old one.
box_login() { # box directory
  [ -f "$CODEX_AUTH" ] || return 1
  (umask 077 && cp "$CODEX_AUTH" "$1/codex/auth.json" && cp "$CODEX_AUTH" "$1/login.was")
}
box_logout() { # box directory
  local box=$1 was now
  if [ -f "$box/codex/auth.json" ] && ! cmp -s "$box/codex/auth.json" "$box/login.was" && cmp -s "$CODEX_AUTH" "$box/login.was"; then
    was=$(jq -r '.tokens.account_id // empty' "$box/login.was" 2>/dev/null)
    now=$(jq -r '.tokens.account_id // empty' "$box/codex/auth.json" 2>/dev/null)
    if [ -n "$was" ] && [ "$was" = "$now" ]; then
      (umask 077 && cp "$box/codex/auth.json" "$CODEX_AUTH.tg-relay" && mv -f "$CODEX_AUTH.tg-relay" "$CODEX_AUTH")
    fi
  fi
  rm -f "$box/codex/auth.json" "$box/login.was"
}

# A Codex thread started or carried on here; run in the background, one at a time per session.
# Sandboxed: in its box, above. Otherwise it has the machine, from the job's directory.
CODEX_MAX=3
codex_run() { # job JSON
  local job=$1 id runner session thread model sandbox cwd token out err pid code told='' msg result box=''
  id=$(printf '%s' "$job" | jq -r .id)
  runner=$(printf '%s' "$job" | jq -r .runner)
  session=$(printf '%s' "$job" | jq -r .session)
  thread=$(printf '%s' "$job" | jq -r '.thread // empty')
  model=$(printf '%s' "$job" | jq -r '.model // empty')
  sandbox=$(printf '%s' "$job" | jq -r '.sandbox // empty')
  cwd=$(printf '%s' "$job" | jq -r '.cwd // empty')
  # The run's own token to the bot, bound to its session: it goes to Codex in its environment only.
  token=$(printf '%s' "$job" | jq -r '.token // empty')
  if [ "$sandbox" = danger-full-access ]; then
    case "$cwd" in
      "" | "~") cwd=$HOME ;;
      "~/"*) cwd="$HOME/$(printf '%s' "$cwd" | cut -c3-)" ;;
    esac
    if [ ! -d "$cwd" ]; then
      report "$id" "$(jq -cn --arg d "$cwd" '{ok:false, error:("no such directory: " + $d)}')"
      return
    fi
  elif [ -z "$BOX_INNER" ]; then
    report "$id" '{"ok":false,"error":"this machine cannot sandbox Codex: bubblewrap does not work here (run the installer again to see why)"}'
    return
  elif ! [[ $session =~ ^cx_[0-9a-f]{24}$ ]]; then
    report "$id" '{"ok":false,"error":"not a session this relay can box"}'
    return
  else
    box="$DIR/sandbox/$session"
    sandbox=$BOX_INNER
    cwd="$HOME/work"
    mkdir -p "$box/codex" "$box/work"
  fi
  # The bot hands out one job of a session at a time; the lock is the second guard. Codex does not
  # get its descriptor (9>&-): whatever it leaves running must not hold the session's lock.
  local lock="$DIR/locks/$session"
  exec 9>"$lock"
  if ! flock -w 60 9; then
    exec 9>&-
    report "$id" '{"ok":false,"error":"another run of this session still holds its lock on the relay"}'
    return
  fi
  if [ -n "$box" ] && ! box_login "$box"; then
    rm -f "$lock"
    exec 9>&-
    report "$id" "$(jq -cn --arg f "$CODEX_AUTH" '{ok:false, error:("no Codex login in " + $f + " for a sandboxed run: run codex login on the relay machine, with its credentials kept in a file")}')"
    return
  fi
  # The sandbox goes as config on a resume too: Codex applies it to the turn (checked with 0.167).
  local args=(--json --skip-git-repo-check -c 'approval_policy="never"' -c "sandbox_mode=\"$sandbox\"")
  [ -n "$model" ] && args+=(-m "$model")
  # The bot's tools, with this run's token, going without asking. The server's name is the relay's
  # own: a "telegram" of the user's in their Codex config stays as it is.
  [ -n "$token" ] && args+=(
    -c "mcp_servers.tg_relay.url=\"$RELAY_ORIGIN/\""
    -c 'mcp_servers.tg_relay.bearer_token_env_var="TG_MCP_TOKEN"'
    -c 'mcp_servers.tg_relay.default_tools_approval_mode="approve"'
  )
  if [ "$runner" = codex-start ]; then
    args=(exec "${"$"}{args[@]}" -C "$cwd" -- -)
  else
    args=(exec resume "${"$"}{args[@]}" -- "$thread" -)
  fi
  out=$(mktemp)
  err=$(mktemp)
  if [ -n "$box" ]; then
    printf '%s' "$job" | jq -r .text | (boxed "$box" 3000 "$CODEX_REAL" "${"$"}{args[@]}" 3<<<"$token" 9>&-) >"$out" 2>"$err" &
  else
    printf '%s' "$job" | jq -r .text | (cd "$cwd" && TG_MCP_TOKEN=$token exec timeout 3000 codex "${"$"}{args[@]}" 9>&-) >"$out" 2>"$err" &
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
  [ -n "$box" ] && box_logout "$box"
  rm -f "$out" "$err" "$lock"
  exec 9>&-
  report "$id" "$result"
  echo "$(date -u +%FT%TZ) $id -> $session: $result"
}

# What this relay runs, its one assistant's jobs: the Worker hands out only those.
mkdir -p "$DIR/sandbox" "$DIR/locks"
# An env file from before the choice has none, and served Claude.
RUNNERS=${"$"}{RELAY_AGENT:-claude}
if [ "$RUNNERS" = codex ]; then
  box_check
  [ -n "$BOX_INNER" ] && RUNNERS="$RUNNERS,codex-sandbox"
fi
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
# Installs the Telegram bot's relay, for one assistant: it passes messages into Claude Code cloud
# sessions (RELAY_AGENT=claude), or runs Codex here (RELAY_AGENT=codex).
# Everything is inside main, run on the last line: a download cut short runs nothing.
set -euo pipefail
main() {
ORIGIN='${origin.replaceAll("'", "")}'
# Run again without a token or an agent, it updates the relay and keeps the ones it has. An env file
# from before there was a choice served Claude, or Codex where it says RELAY_CODEX=1.
if [ -f "$HOME/.tg-relay/env" ]; then
  [ -z "${"$"}{RELAY_TOKEN:-}" ] && RELAY_TOKEN=$(sed -n 's/^RELAY_TOKEN=//p' "$HOME/.tg-relay/env")
  if [ -z "${"$"}{RELAY_AGENT:-}" ]; then
    RELAY_AGENT=$(sed -n 's/^RELAY_AGENT=//p' "$HOME/.tg-relay/env")
    if [ -z "$RELAY_AGENT" ]; then
      if grep -qx 'RELAY_CODEX=1' "$HOME/.tg-relay/env"; then RELAY_AGENT=codex; else RELAY_AGENT=claude; fi
    fi
  fi
fi
if [ -z "${"$"}{RELAY_TOKEN:-}" ]; then
  echo "Run it as: curl -fsSL $ORIGIN/relay/install.sh | RELAY_TOKEN=relay_... RELAY_AGENT=claude bash" >&2
  echo "(the bot's menu gives you the command with your token)" >&2
  exit 1
fi
# The relay serves one assistant, the one named: nothing is assumed.
AGENT="${"$"}{RELAY_AGENT:-}"
if [ "$AGENT" != claude ] && [ "$AGENT" != codex ]; then
  echo "Say which assistant this relay serves, one of:" >&2
  echo "  RELAY_AGENT=claude   passes messages into your Claude Code cloud sessions (installs Claude Code)" >&2
  echo "  RELAY_AGENT=codex    runs the Codex CLI on this machine (installs Codex and bubblewrap)" >&2
  echo "The install command in the bot's menu has it: copy it from the screen of the one you want." >&2
  exit 1
fi
BOX=
have() { command -v "$1" >/dev/null 2>&1; }
packages() { # names…: installs them with the system's package manager, if it knows one
  if have apt-get; then sudo apt-get update -qq </dev/null && sudo apt-get install -y -qq "$@" </dev/null
  elif have dnf; then sudo dnf install -y -q "$@" </dev/null
  elif have yum; then sudo yum install -y -q "$@" </dev/null
  else return 1; fi
}
if ! have curl || ! have jq; then
  packages curl jq || { echo "Install curl and jq, then run this again." >&2; exit 1; }
fi
export PATH="$HOME/.local/bin:$PATH"
if [ "$AGENT" = codex ]; then
  if ! have codex; then
    if ! have npm; then
      echo "Codex comes from npm: install Node.js 18 or newer with npm (https://nodejs.org), then run this again." >&2
      exit 1
    fi
    npm install -g @openai/codex </dev/null || sudo npm install -g @openai/codex </dev/null
    have codex || { echo "Codex was installed but is not on PATH: add npm's global bin directory to PATH and run this again." >&2; exit 1; }
  fi
  # Sandboxed runs go inside bubblewrap. Without a working one the relay refuses them, never runs
  # them unsandboxed: what is wrong is said at the end.
  have bwrap || packages bubblewrap || true
  if ! have bwrap; then
    BOX=missing
  elif ! bwrap --ro-bind / / true 2>/dev/null; then
    if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then BOX=apparmor; else BOX=broken; fi
  else
    BOX=ok
  fi
elif ! have claude; then
  # Its installer from a file: piped into bash, the </dev/null that keeps it off the terminal would replace it.
  CLAUDE_SETUP=$(mktemp)
  curl -fsSL https://claude.ai/install.sh -o "$CLAUDE_SETUP"
  bash "$CLAUDE_SETUP" </dev/null
  rm -f "$CLAUDE_SETUP"
fi
# The service sees only these: where its assistant and node are, and the usual.
RUN_PATH=/usr/local/bin:/usr/bin:/bin
for tool in node "$AGENT"; do
  if have "$tool"; then RUN_PATH="$(dirname "$(command -v "$tool")"):$RUN_PATH"; fi
done

DIR="$HOME/.tg-relay"
mkdir -p "$DIR" && chmod 700 "$DIR"
printf 'RELAY_TOKEN=%s\nRELAY_ORIGIN=%s\nRELAY_AGENT=%s\n' "$RELAY_TOKEN" "$ORIGIN" "$AGENT" >"$DIR/env"
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
if [ "$AGENT" = claude ]; then
  if ! claude auth status 2>/dev/null | grep -q '"loggedIn": true'; then
    echo "Now sign Claude Code in once: run claude, then /login. Then: sudo systemctl restart tg-relay"
  else
    echo "Claude Code is signed in. After any new /login, run: sudo systemctl restart tg-relay"
  fi
fi
if [ "$AGENT" = codex ]; then
  # Each run gets a sign-in of its own from the bot, under a name of the relay's: the user's own
  # Codex config is left as it is, a "telegram" server in it included.
  if codex mcp get telegram >/dev/null 2>&1; then
    echo "Your Codex config has an MCP server named telegram (an older version of this installer set it up)."
    echo "The relay no longer uses it: each run gets its own. Keep it for your own use, or: codex mcp remove telegram"
  fi
  echo
  echo "Sign Codex in once, here, if it is not yet:"
  echo "  codex login                (without a browser: codex login --device-auth)"
  echo "  sudo systemctl restart tg-relay"
fi
case "$BOX" in
  ok) echo; echo "bubblewrap works: sandboxed Codex runs go inside it." ;;
  missing)
    echo
    echo "bubblewrap (bwrap) is not installed, and this could not install it. Until it is, sandboxed Codex"
    echo "runs are refused (with the sandbox policy None nothing needs it). Install it, then run this again."
    ;;
  apparmor)
    echo
    echo "bubblewrap is installed, but AppArmor keeps it from making a sandbox here"
    echo "(kernel.apparmor_restrict_unprivileged_userns=1). Until that is fixed, sandboxed Codex runs are refused."
    echo "Allow it for bwrap alone, with this profile:"
    echo
    cat <<PROFILE
sudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap $(command -v bwrap) flags=(unconfined) {
  userns,

  include if exists <local/bwrap>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/bwrap
sudo systemctl restart tg-relay
PROFILE
    echo
    echo "(Or allow it for every program: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0)"
    ;;
  broken)
    echo
    echo "bubblewrap is installed but cannot make a sandbox here (bwrap --ro-bind / / true fails): unprivileged"
    echo "user namespaces are likely off (sysctl user.max_user_namespaces, or kernel.unprivileged_userns_clone on"
    echo "Debian). Until it works, sandboxed Codex runs are refused (with the sandbox policy None nothing needs it)."
    echo "Then: sudo systemctl restart tg-relay"
    ;;
esac
}
main "$@"
`;
}
