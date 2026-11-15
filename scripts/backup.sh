#!/bin/sh
# Run from the formal CFO directory. Contains private financial data and secrets.
set -eu
umask 077
backup_root=${CFO_BACKUP_DIR:-/volume1/docker/cfo-backups}
stamp=$(date +%Y%m%d-%H%M%S)
dest="$backup_root/$stamp"
mkdir -p "$dest"
cfo_backup_app=$(docker compose ps -aq app)
if [ -z "$cfo_backup_app" ]; then echo 'CFO app container not found'; exit 1; fi
cfo_backup_image=$(docker inspect -f '{{.Image}}' "$cfo_backup_app")
cfo_backup_was_running=$(docker inspect -f '{{.State.Running}}' "$cfo_backup_app")
cfo_backup_project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$cfo_backup_app")
cfo_backup_collectors=$(docker ps -q --filter "label=com.docker.compose.project=$cfo_backup_project" --filter 'label=com.docker.compose.service=portfolio-sync')
restore_app(){
 if [ "$cfo_backup_was_running" = true ]; then docker start "$cfo_backup_app" >/dev/null; fi
 for cfo_collector in $cfo_backup_collectors; do docker start "$cfo_collector" >/dev/null; done
}
trap restore_app EXIT
trap 'exit 1' HUP INT TERM
for cfo_collector in $cfo_backup_collectors; do docker stop "$cfo_collector" >/dev/null; done
if [ "$cfo_backup_was_running" = true ]; then docker stop "$cfo_backup_app" >/dev/null; fi
docker compose exec -T postgres pg_dump -U cfo -d cfo -Fc > "$dest/database.dump"
docker run --rm --network none --user 0:0 --volumes-from "$cfo_backup_app:ro" --entrypoint /bin/sh "$cfo_backup_image" -c 'tar -C /data -cf - originals' > "$dest/originals.tar"
docker run --rm --network none --user 0:0 --volumes-from "$cfo_backup_app:ro" --entrypoint /bin/sh "$cfo_backup_image" -c 'tar -C /run/cfo -cf - .' > "$dest/credentials.tar"
for cfo_config in compose.yaml compose.https.yaml compose.chatgpt.yaml compose.cloudflare.yaml compose.import.yaml compose.portfolio.yaml .env .env.public .env.chatgpt .env.portfolio secrets; do
 if [ -e "$cfo_config" ]; then printf '%s\n' "$cfo_config"; fi
done > "$dest/config-files.list"
tar -cf "$dest/config-private.tar" -T "$dest/config-files.list"
printf 'BACKUP_READY: %s\n' "$dest"
