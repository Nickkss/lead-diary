#!/usr/bin/env bash
# Update Lead Diary to the latest version (or apply .env changes). Your data is kept.
#   cd /opt/lead-diary && sudo bash update.sh
set -euo pipefail
cd "$(dirname "$0")"
git pull --ff-only || echo "Couldn't pull updates; restarting the current version."
set -a; . ./.env; set +a
if [ "${PROXY_MODE:-caddy}" = caddy ]; then docker compose --profile caddy up -d --build
else docker compose up -d --build app; fi
docker image prune -f >/dev/null 2>&1 || true
echo "Lead Diary updated: ${PUBLIC_URL:-}"
