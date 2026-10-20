#!/bin/sh

#####################################################
# NAS-side half of bin/deploy-synology. Runs as root
# on the Synology. Do not run this directly on Windows.
#
#   sh deploy-synology-remote.sh <tag> <all|server|importer> <host-port>
#
# Server:
# 1. Loads the images for <tag> from the staging dir (if not loaded)
# 2. Stops the running server and backs up the data dir
# 3. Keeps the old container as <name>-prev, starts the new one
# 4. Health-checks it; on failure restores the old container
#
# Importer (after a successful server deploy):
# 1. Creates /volume1/docker/actual-import (inbox, processed, ...)
# 2. First install only: installs the config from the staging dir
#    and asks for the Actual server password (stored root-only)
# 3. Replaces the importer container; restores the old one if the
#    new one does not stay running
#
# Both containers share the "actual-net" network so the importer
# reaches the server as http://actual-server1:5006.
# Server settings mirror the Container Manager config
# (actual-server1.syno.json).
#####################################################

set -eu

PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

USAGE="usage: $0 <tag> <all|server|importer> <host-port>"
TAG="${1:?$USAGE}"
COMPONENTS="${2:?$USAGE}"
# Host port the Actual server is published on (from nas-config/deploy.env).
HOST_PORT="${3:?$USAGE}"

NETWORK=actual-net

NAME=actual-server1
IMAGE_REPO=actual-server
DATA_DIR=/volume1/docker/actual

IMPORTER_NAME=actual-bank-importer
IMPORTER_REPO=actual-bank-importer
IMPORT_DIR=/volume1/docker/actual-import
IMPORTER_ENV="$IMPORT_DIR/importer.env"
IMPORTER_WATCH_SECONDS=300

STAGING_DIR=/volume1/docker/images
BACKUP_DIR=/volume1/docker/backups/actual
KEEP=5

ARCHIVE="$STAGING_DIR/actual-$TAG.tar.gz"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

log() { echo "[nas] $*"; }

# Delete all but the newest $KEEP files matching a glob.
prune_files() {
  ls -1t $1 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do
    log "Pruning $f"
    rm -f "$f"
  done
}

# Remove tagged images of a repo that no longer have a staged archive
# (images still used by a container are kept by docker).
prune_images() {
  docker images "$1" --format '{{.Tag}}' | while read -r t; do
    case "$t" in latest | "$TAG") continue ;; esac
    [ -f "$STAGING_DIR/actual-$t.tar.gz" ] || docker rmi "$1:$t" >/dev/null 2>&1 || true
  done
}

load_image() {
  if ! docker image inspect "$1" >/dev/null 2>&1; then
    [ -f "$ARCHIVE" ] || { log "Missing $ARCHIVE"; exit 1; }
    log "Loading $ARCHIVE"
    docker load -i "$ARCHIVE"
    docker image inspect "$1" >/dev/null 2>&1 || { log "$ARCHIVE does not contain $1"; exit 1; }
  fi
}

ensure_network() {
  docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
}

#####################################################
# Server
#####################################################

deploy_server() {
  IMAGE="$IMAGE_REPO:$TAG"
  load_image "$IMAGE"
  ensure_network

  HAD_OLD=false
  if docker container inspect "$NAME" >/dev/null 2>&1; then
    HAD_OLD=true
    log "Stopping $NAME"
    docker stop "$NAME" >/dev/null
  fi

  mkdir -p "$BACKUP_DIR"
  BACKUP="$BACKUP_DIR/actual-data-$TIMESTAMP.tar.gz"
  log "Backing up $DATA_DIR to $BACKUP"
  if ! tar -czf "$BACKUP" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"; then
    rm -f "$BACKUP"
    if [ "$HAD_OLD" = true ]; then docker start "$NAME" >/dev/null; fi
    log "Deploy of $TAG FAILED: could not back up $DATA_DIR (old container restarted)"
    exit 1
  fi

  if [ "$HAD_OLD" = true ]; then
    docker rm "$NAME-prev" >/dev/null 2>&1 || true
    docker rename "$NAME" "$NAME-prev"
  fi

  log "Starting $NAME from $IMAGE"
  docker run -d \
    --name "$NAME" \
    --restart always \
    --network "$NETWORK" \
    -p "$HOST_PORT:5006" \
    -v "$DATA_DIR:/data" \
    -e NODE_ENV=production \
    "$IMAGE" >/dev/null || restore_server "docker run failed; data backup is at $BACKUP"

  log "Waiting for health check on port $HOST_PORT"
  i=0
  until curl -fsS "http://127.0.0.1:$HOST_PORT/health" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ $i -ge 45 ]; then
      log "New container failed its health check. Last log lines:"
      docker logs --tail 40 "$NAME" || true
      restore_server "health check failed; data backup is at $BACKUP"
    fi
    sleep 2
  done

  # Keep :latest pointing at the running image so a Container
  # Manager restore from the saved JSON config still works.
  docker tag "$IMAGE" "$IMAGE_REPO:latest"
  docker rm "$NAME-prev" >/dev/null 2>&1 || true
  prune_files "$BACKUP_DIR/actual-data-*.tar.gz"
  log "Server $TAG is up; data backup is at $BACKUP"
}

# Put the previous server container back and abort.
restore_server() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [ "$HAD_OLD" = true ]; then
    log "Restoring previous container"
    if docker container inspect "$NAME-prev" >/dev/null 2>&1; then
      docker rename "$NAME-prev" "$NAME"
    fi
    docker start "$NAME" >/dev/null
    docker tag "$(docker inspect -f '{{.Image}}' "$NAME")" "$IMAGE_REPO:latest"
  fi
  log "Deploy of $TAG FAILED: $1"
  exit 1
}

#####################################################
# Importer
#####################################################

deploy_importer() {
  IMAGE="$IMPORTER_REPO:$TAG"
  load_image "$IMAGE"
  ensure_network

  if ! docker container inspect "$NAME" >/dev/null 2>&1; then
    log "Importer not deployed: the server container $NAME does not exist"
    exit 1
  fi
  # A server started outside this script (e.g. Container Manager) may not be
  # on the shared network yet.
  docker network connect "$NETWORK" "$NAME" >/dev/null 2>&1 || true

  for d in inbox processed failed reports state cache; do
    mkdir -p "$IMPORT_DIR/$d"
  done

  if [ ! -f "$IMPORT_DIR/config.json" ]; then
    if [ -f "$STAGING_DIR/importer-config.json" ]; then
      log "Installing importer config to $IMPORT_DIR/config.json"
      cp "$STAGING_DIR/importer-config.json" "$IMPORT_DIR/config.json"
    else
      log "Importer not deployed: $IMPORT_DIR/config.json is missing"
      exit 1
    fi
  fi
  rm -f "$STAGING_DIR/importer-config.json"

  if [ ! -f "$IMPORTER_ENV" ]; then
    printf '[nas] Actual server password (stored in %s, readable by root only): ' "$IMPORTER_ENV"
    stty -echo 2>/dev/null || true
    read -r PASSWORD
    stty echo 2>/dev/null || true
    echo
    [ -n "$PASSWORD" ] || { log "Importer not deployed: no password given"; exit 1; }
    umask 077
    printf 'ACTUAL_PASSWORD=%s\n' "$PASSWORD" > "$IMPORTER_ENV"
    chmod 600 "$IMPORTER_ENV"
  fi

  HAD_OLD_IMPORTER=false
  if docker container inspect "$IMPORTER_NAME" >/dev/null 2>&1; then
    HAD_OLD_IMPORTER=true
    log "Stopping $IMPORTER_NAME"
    docker stop "$IMPORTER_NAME" >/dev/null
    docker rm "$IMPORTER_NAME-prev" >/dev/null 2>&1 || true
    docker rename "$IMPORTER_NAME" "$IMPORTER_NAME-prev"
  fi

  log "Starting $IMPORTER_NAME from $IMAGE"
  if docker run -d \
    --name "$IMPORTER_NAME" \
    --restart always \
    --network "$NETWORK" \
    -v "$IMPORT_DIR:/import" \
    --env-file "$IMPORTER_ENV" \
    -e "ACTUAL_SERVER_URL=http://$NAME:5006" \
    "$IMAGE" run --watch "$IMPORTER_WATCH_SECONDS" >/dev/null; then
    sleep 20
  fi

  if [ "$(docker inspect -f '{{.State.Running}}' "$IMPORTER_NAME" 2>/dev/null)" != true ]; then
    log "Importer did not stay running. Last log lines:"
    docker logs --tail 40 "$IMPORTER_NAME" 2>&1 || true
    docker rm -f "$IMPORTER_NAME" >/dev/null 2>&1 || true
    if [ "$HAD_OLD_IMPORTER" = true ]; then
      log "Restoring previous importer"
      docker rename "$IMPORTER_NAME-prev" "$IMPORTER_NAME"
      docker start "$IMPORTER_NAME" >/dev/null
    fi
    log "Importer deploy of $TAG FAILED"
    exit 1
  fi

  docker tag "$IMAGE" "$IMPORTER_REPO:latest"
  docker rm "$IMPORTER_NAME-prev" >/dev/null 2>&1 || true
  log "Importer $TAG is running. First log lines:"
  docker logs --tail 10 "$IMPORTER_NAME" 2>&1 || true
}

case "$COMPONENTS" in
  all) deploy_server; deploy_importer ;;
  server) deploy_server ;;
  importer) deploy_importer ;;
  *) log "Unknown component '$COMPONENTS'"; exit 1 ;;
esac

prune_files "$STAGING_DIR/actual-*.tar.gz"
prune_images "$IMAGE_REPO"
prune_images "$IMPORTER_REPO"

log "Deploy of $TAG ($COMPONENTS) succeeded"
