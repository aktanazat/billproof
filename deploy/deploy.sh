#!/bin/sh
# Updates the live site: saves the running app's log, pulls, and rebuilds. A rebuild replaces the app's container, and
# Docker deletes a container's log with it, so the log is appended to logs/app.log first: all of it the first time,
# then only what came since that container's last save, since a deploy with no changes keeps the same container.
set -eu

# The whole script is read before it runs, since `git pull` below can rewrite this file mid-run.
main() {
  cd "$(dirname "$0")/.."
  mkdir -p logs
  container=$(docker ps -q --filter name=billproof-app-1)
  if [ -n "$container" ]; then
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
  docker builder prune -f >/dev/null
  docker image prune -f >/dev/null
}
main "$@"; exit
