/**
 * The relay's installer, served at /relay/install.sh. One command on any
 * always-on Linux machine (an Oracle free VM will do):
 *
 *   curl -fsSL https://<worker>/relay/install.sh | RELAY_TOKEN=relay_… bash
 *
 * It installs curl, jq and Claude Code if missing, writes ~/.tg-relay/relay.sh
 * and a systemd service running it as the current user, and starts it. The
 * relay only asks the Worker for work, so it needs no open port, domain or
 * public address. Claude Code must be signed in once on that machine
 * (`claude`, then /login) — the relay writes to sessions as that account.
 *
 * Kept free of `${…}`: the shell's own syntax would clash with the template.
 */

const RELAY_LOOP = String.raw`#!/usr/bin/env bash
# Passes messages from the Telegram bot into Claude Code cloud sessions.
set -uo pipefail
API="$RELAY_ORIGIN/relay"
AUTH="Authorization: Bearer $RELAY_TOKEN"
START=1
while true; do
  JOBS=$(curl -fsS --max-time 30 -H "$AUTH" "$API/jobs?start=$START") || { sleep 15; continue; }
  START=0
  COUNT=$(printf '%s' "$JOBS" | jq 'length' 2>/dev/null || echo 0)
  for ((i = 0; i < COUNT; i++)); do
    JOB=$(printf '%s' "$JOBS" | jq -c ".[$i]")
    ID=$(printf '%s' "$JOB" | jq -r .id)
    SESSION=$(printf '%s' "$JOB" | jq -r .session)
    ERR=$(mktemp)
    OUT=$(printf '%s' "$JOB" | jq -r .text | timeout 300 claude -p --cloud "$SESSION" --output-format json 2>"$ERR")
    if [ "$(printf '%s' "$OUT" | head -n 1 | jq -r '.ok // false' 2>/dev/null)" = "true" ]; then
      REPORT='{"ok":true}'
    else
      REPORT=$(jq -cn --arg out "$OUT" --rawfile err "$ERR" '{ok:false, error:((($out|fromjson?).error) // ($err + $out))}')
    fi
    rm -f "$ERR"
    printf '%s' "$REPORT" | curl -fsS --max-time 30 -X POST -H "$AUTH" -H 'Content-Type: application/json' --data-binary @- "$API/jobs/$ID" >/dev/null || true
    echo "$(date -u +%FT%TZ) $ID -> $SESSION: $REPORT"
  done
  sleep 5
done
`;

export function installScript(origin: string): string {
  return String.raw`#!/usr/bin/env bash
# Installs the Telegram bot's relay, which passes messages into Claude Code cloud sessions.
set -euo pipefail
ORIGIN='${origin.replaceAll("'", "")}'
if [ -z "${"$"}{RELAY_TOKEN:-}" ]; then
  echo "Run it as: curl -fsSL $ORIGIN/relay/install.sh | RELAY_TOKEN=relay_... bash" >&2
  exit 1
fi
have() { command -v "$1" >/dev/null 2>&1; }
if ! have curl || ! have jq; then
  if have apt-get; then sudo apt-get update -qq && sudo apt-get install -y -qq curl jq
  elif have dnf; then sudo dnf install -y -q curl jq
  elif have yum; then sudo yum install -y -q curl jq
  else echo "Install curl and jq, then run this again." >&2; exit 1; fi
fi
export PATH="$HOME/.local/bin:$PATH"
if ! have claude; then curl -fsSL https://claude.ai/install.sh | bash; fi
CLAUDE_DIR=$(dirname "$(command -v claude)")

DIR="$HOME/.tg-relay"
mkdir -p "$DIR" && chmod 700 "$DIR"
printf 'RELAY_TOKEN=%s\nRELAY_ORIGIN=%s\n' "$RELAY_TOKEN" "$ORIGIN" >"$DIR/env"
chmod 600 "$DIR/env"
cat >"$DIR/relay.sh" <<'RELAY'
${RELAY_LOOP}RELAY
chmod 700 "$DIR/relay.sh"

sudo tee /etc/systemd/system/tg-relay.service >/dev/null <<UNIT
[Unit]
Description=Telegram bot relay to Claude Code sessions
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$HOME
EnvironmentFile=$DIR/env
Environment=PATH=$CLAUDE_DIR:/usr/local/bin:/usr/bin:/bin
ExecStart=$DIR/relay.sh
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
if ! claude auth status 2>/dev/null | grep -q '"loggedIn": true'; then
  echo "Now sign Claude Code in once: run claude, then /login. Then: sudo systemctl restart tg-relay"
else
  echo "Claude Code is signed in. After any new /login, run: sudo systemctl restart tg-relay"
fi
`;
}
