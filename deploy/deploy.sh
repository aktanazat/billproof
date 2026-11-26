#!/bin/sh
# Updates the live site: saves the running app's log, pulls, and rebuilds. A rebuild replaces the app's container,
# which cuts off any check running in it, so the deploy stops first while a check may be running (active-checks.mjs).
# Docker deletes a container's log with it, so the log is appended to logs/app.log first: all of it the first time,
# then only what came since that container's last save.
set -eu

# The whole script is read before it runs, since `git pull` below can rewrite this file mid-run.
main() {
  cd "$(dirname "$0")/.."
  mkdir -p logs
  container=$(docker ps -q --filter name=billproof-app-1)
  if [ -n "$container" ]; then
    docker exec -i "$container" node --input-type=module - <deploy/active-checks.mjs || exit 1
    last=$(grep "^=== container $container," logs/app.log 2>/dev/null | tail -1 | sed 's/.*, saved //')
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    {
      echo "=== container $container, started $(docker inspect -f '{{.State.StartedAt}}' "$container"), saved $now"
      if [ -n "$last" ]; then docker logs --timestamps --since "$last" "$container" 2>&1; else docker logs --timestamps "$container" 2>&1; fi
    } >>logs/app.log
  fi
  git pull -q
  cd deploy
  docker compose -p billproof up -d --build 2>&1 | tail -1
  # Caddy's folder is mounted, so a pulled Caddyfile is seen; a reload applies it and keeps connections open.
  docker compose -p billproof exec -T caddy caddy reload --config /etc/caddy/Caddyfile
  docker builder prune -f >/dev/null
  docker image prune -f >/dev/null
}
main "$@"; exit
