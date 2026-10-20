## Use Git Bash

## Install
`yarn install`

## Build Server
`yarn build:server`

## Docker
`docker build -t actual-server .`

`docker save actual-server -o ../actual.tar`


## Deploy to the Synology (one command)
PowerShell: `.\bin\deploy-synology.ps1 <ssh-user>` (runs the bash script below via Git Bash)
Git Bash: `bin/deploy-synology <ssh-user>`
Add `server` or `importer` after the user to deploy just one.

Connection settings are in `nas-config/deploy.env` (git-ignored, not in the repo):
```
SYNO_HOST=<NAS address>
SYNO_PORT=<SSH port>
ACTUAL_HOST_PORT=<host port the Actual server is published on>
```

Builds the server and bank importer images, uploads them to `/volume1/docker/images`,
backs up `/volume1/docker/actual` to `/volume1/docker/backups/actual`, replaces the
`actual-server1` container (rolled back automatically if it fails its health check),
then replaces the `actual-bank-importer` container.

First importer install: the NAS asks for the Actual server password (kept in
`/volume1/docker/actual-import/importer.env`, root only) and installs
`nas-config/importer-config.json` (git-ignored, has account numbers) as
`/volume1/docker/actual-import/config.json`. Later deploys never overwrite either.

Roll back / redeploy an earlier build: `bin/deploy-synology <ssh-user> [all|server|importer] --redeploy <tag>`
(tags are the `actual-<tag>.tar.gz` files in `/volume1/docker/images`; the last 5 are kept).

## Importing bank files
Drop `.ofx` / `.qfx` downloads into `/volume1/docker/actual-import/inbox` (the `docker`
share). Every 5 minutes they are imported and moved to `processed/` (or `failed/`).
Logs: Container Manager → `actual-bank-importer` → Log. Reports: `reports/`.
`"dryRun": true` in `config.json` reports without importing (takes effect next cycle).
See `packages/bank-importer/README.md` for downloading from BMO and RBC.
