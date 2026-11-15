#!/bin/sh
set -eu
cd /volume1/docker/cfo
# Does not stop the CFO website/database and does not unmount shared files.
docker compose --env-file .env.portfolio -f compose.yaml -f compose.portfolio.yaml stop portfolio-sync
