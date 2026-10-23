#!/usr/bin/env bash
# Lead Diary installer for an Ubuntu/Debian VPS (Hostinger and similar).
#   curl -fsSL https://raw.githubusercontent.com/Nickkss/lead-diary/main/install.sh | sudo bash
# Safe to run again: it keeps your .env and data, and just updates the app.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Nickkss/lead-diary.git}"
DIR="${DIR:-/opt/lead-diary}"
APP_PORT=3010
say()  { printf "\n\033[1;34m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!!\033[0m %s\n" "$*"; }
ask()  { local p="$1" v; read -r -p "$p" v </dev/tty || true; printf "%s" "$v"; }
asks() { local p="$1" v; read -r -s -p "$p" v </dev/tty || true; echo >&2; printf "%s" "$v"; }

[ "$(id -u)" -eq 0 ] || { echo "Please run as root: sudo bash install.sh"; exit 1; }

say "Checking tools"
export DEBIAN_FRONTEND=noninteractive
command -v git  >/dev/null || { apt-get update -qq && apt-get install -y -qq git; }
command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq curl; }
if ! command -v docker >/dev/null; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq docker-compose-plugin; }
systemctl enable --now docker >/dev/null 2>&1 || true

say "Getting the app into $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only
else git clone --depth 1 "$REPO_URL" "$DIR"; fi
cd "$DIR"

IP="$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"

if [ ! -f .env ]; then
  say "A few questions (press Enter to skip any of them)"
  echo "Your server's IP address is: $IP"
  DOMAIN="$(ask "Domain for the app, e.g. leads.yourcompany.com (Enter = free address): ")"
  if [ -z "$DOMAIN" ]; then DOMAIN="${IP//./-}.sslip.io"; echo "Using free address: $DOMAIN"; fi
  KEY="$(asks "Anthropic API key for AI features (starts with sk-ant-, Enter = add later): ")"
  echo "AI model:  1) Claude Haiku 5.5 - low cost, good for everyday notes"
  echo "           2) Claude Opus 5.5  - best quality, costs much more"
  M="$(ask "Choose 1 or 2 [1]: ")"
  if [ "$M" = 2 ]; then MODEL=claude-opus-5-5; else MODEL=claude-haiku-5-5; fi
  # pick a local port nothing else is using (other projects may already use 3010)
  for p in 3010 3011 3012 3013 3014 3015 3020 3030 3040 3050; do ss -ltnH "( sport = :$p )" | grep -q . || { APP_PORT=$p; break; }; done
  umask 077
  cat > .env <<EOF
DOMAIN=$DOMAIN
PUBLIC_URL=https://$DOMAIN
TZ=Asia/Kolkata
ANTHROPIC_API_KEY=$KEY
AI_MODEL=$MODEL
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
PROXY_MODE=
APP_PORT=$APP_PORT
EOF
fi
set -a; . ./.env; set +a
APP_PORT="${APP_PORT:-3010}"

# DNS sanity check for a custom domain
if [[ "$DOMAIN" != *.sslip.io ]]; then
  RES="$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}' || true)"
  if [ "$RES" != "$IP" ]; then
    warn "$DOMAIN points to '${RES:-nothing}', not to this server ($IP)."
    warn "Add an A record for $DOMAIN -> $IP at your domain provider. HTTPS will start working once it updates."
  fi
fi

port_busy() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q . ; }
if [ -z "${PROXY_MODE:-}" ]; then
  if ! port_busy 80 && ! port_busy 443; then PROXY_MODE=caddy
  elif systemctl is-active --quiet nginx; then PROXY_MODE=nginx
  else PROXY_MODE=manual; fi
  sed -i "s/^PROXY_MODE=.*/PROXY_MODE=$PROXY_MODE/" .env
fi

say "Building and starting Lead Diary (first time takes a few minutes)"
if [ "$PROXY_MODE" = caddy ]; then
  docker compose --profile caddy up -d --build
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
else
  docker compose up -d --build app
fi

if [ "$PROXY_MODE" = nginx ]; then
  say "Your server already runs nginx. Adding a site for $DOMAIN"
  cat > /etc/nginx/sites-available/lead-diary <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 8m;
    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_buffering off;          # live updates
        proxy_read_timeout 1h;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/lead-diary /etc/nginx/sites-enabled/lead-diary
  nginx -t && systemctl reload nginx
  command -v certbot >/dev/null || apt-get install -y -qq certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
    || warn "HTTPS certificate failed. Check that $DOMAIN points to $IP, then run: certbot --nginx -d $DOMAIN"
fi

say "Waiting for the app to start"
for i in $(seq 1 60); do curl -fsS "http://127.0.0.1:$APP_PORT/api/session" >/dev/null 2>&1 && break; sleep 2; done
CODE="$(docker compose exec -T app sh -c 'cat /data/setup-code.txt 2>/dev/null' || true)"

echo
echo "============================================================"
echo "  Lead Diary is running:  https://$DOMAIN"
if [ -n "$CODE" ]; then echo "  Your one-time setup code:  $CODE"; else echo "  (Already set up. Sign in with your password.)"; fi
[ "$PROXY_MODE" = manual ] && echo "  Ports 80/443 are used by another program. Point it to http://127.0.0.1:$APP_PORT for $DOMAIN."
[ -z "${ANTHROPIC_API_KEY:-}" ] && echo "  AI is off. Add ANTHROPIC_API_KEY to $DIR/.env, then: cd $DIR && bash update.sh"
echo "  Google Calendar: see README.md, section Google Calendar."
echo "============================================================"
