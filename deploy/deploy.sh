#!/bin/sh
# Updates the live site: saves the running app's log, pulls, and rebuilds. A rebuild replaces the app's container, and
# Docker deletes a container's log with it, so the log is appended to logs/app.log first, once per container.
set -eu
cd "$(dirname "$0")/.."
mkdir -p logs
container=$(docker ps -q --filter name=billproof-app-1)
if [ -n "$container" ] && ! grep -q "=== container $container" logs/app.log 2>/dev/null; then
  {
    echo "=== container $container, started $(docker inspect -f '{{.State.StartedAt}}' "$container"), saved $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    docker logs --timestamps "$container" 2>&1
  } >>logs/app.log
fi
git pull -q
cd deploy
docker compose -p billproof up -d --build 2>&1 | tail -1
docker builder prune -f >/dev/null
docker image prune -f >/dev/null
