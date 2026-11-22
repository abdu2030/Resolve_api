# Staging deployment and restore

This runbook uses one Docker host for the API, worker, PostgreSQL, Redis, and
Caddy. Only the HTTPS proxy publishes a host port. It binds to loopback by
default. For remote testers, bind it to the host's private interface and limit
inbound access to the staging network or VPN. PostgreSQL, Redis, and the API
listen on Compose networks.

## Configure the host

Use a Linux host with Docker Engine 28 or later, Docker Compose 2.24.4 or
later, Bash, OpenSSL, and curl. Node.js 24 or later is needed on the client
that runs the [MVP demo](testing/week3-day7-mvp-demo.md). Obtain a PEM
certificate chain and private key for the staging DNS name from a CA your
clients trust. Store both outside the checkout and restrict access to the key.
See the [Docker port publishing guide](https://docs.docker.com/engine/network/port-publishing/)
and [Compose file merge reference](https://docs.docker.com/reference/compose-file/merge/).

From the repository root, set up a dedicated Bash session. Keep the env file
outside the checkout and protect it with permissions `0600`.

```bash
set -euo pipefail
umask 077
staging_env="${XDG_CONFIG_HOME:-$HOME/.config}/resolve/staging.env"
stage_project=resolve-staging
mkdir -p "$(dirname "$staging_env")"
if [ ! -e "$staging_env" ]; then
  install -m 600 .env.staging.example "$staging_env"
fi

stage() {
  docker compose --env-file "$staging_env" --project-name "$stage_project" \
    -f docker-compose.yml -f docker-compose.staging.yml "$@"
}
```

Fill in [the env template](../.env.staging.example). On a new deployment,
generate three independent values with `openssl rand -hex 32` for
`POSTGRES_PASSWORD`, `METRICS_TOKEN`, and `WEBHOOK_ENCRYPTION_KEY`. Hex
keeps the database password safe to interpolate into the connection URL.
Set `STAGING_HOSTNAME` to the certificate's DNS name and `STAGING_TLS_CERT`
and `STAGING_TLS_KEY` to absolute file paths. Set `STAGING_BIND_IP` only if
the proxy should accept connections on a private interface. The port defaults
to 443. Use a clean shell without exported development database or staging
variables because exported values take precedence over the env file.

Keep the webhook encryption key and deployment settings in a separate,
protected secret backup. The matching key is needed to use webhook secrets
from a restored database. Changing the env file alone does not rotate the
password of an existing PostgreSQL volume.

## Deploy and verify

For an upgrade, take the backup below from the currently deployed checkout
before changing revisions. Then check out the exact commit you want to deploy.

```bash
stage config --quiet
stage up -d --build --wait
stage ps --all
stage logs --tail=50 migrate api worker proxy
```

The migration service must exit with code 0 before the API or worker can
start. The API and its dependencies should report healthy. Only the proxy
should show a published port. If an upgrade migration fails, inspect
`stage logs migrate` before retrying.

From a client that trusts the staging certificate, verify readiness through
HTTPS. Replace the name, IP address, and port with the staging settings. Use
the host's private IP from a remote client. Add `--cacert /path/to/ca.pem`
if an internal CA is outside the client's system trust store.

```bash
staging_host=resolve-staging.example.test
staging_ip=127.0.0.1
staging_port=443
staging_url="https://$staging_host:$staging_port"
curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 1 \
  --resolve "$staging_host:$staging_port:$staging_ip" "$staging_url/health/ready"
```

With staging DNS configured, run the [two-tenant demo](testing/week3-day7-mvp-demo.md)
with `RESOLVE_BASE_URL` set to the HTTPS URL. For bootstrap commands use
`stage exec -T api` in place of `docker compose exec -T api`. If Node needs
to trust an internal CA, set `NODE_EXTRA_CA_CERTS` to the CA's PEM file
before running the demo. The demo must finish the batch and return all
expected isolation denials.

After replacing certificate files or changing proxy settings, recreate
the proxy with `stage up -d --no-deps --force-recreate proxy` and verify
HTTPS again.

## Back up PostgreSQL and Redis

Use a maintenance window. The commands stop HTTPS ingress, then the API and
worker, then Redis. PostgreSQL stays online for the dump. Capturing both
stores after writes stop keeps the durable job records and the BullMQ queue
at the same checkpoint. The Redis archive includes the whole data directory
and its [append-only files](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/).

```bash
backup_root="${XDG_STATE_HOME:-$HOME/.local/state}/resolve/backups"
mkdir -p "$backup_root"
backup="$(mktemp -d "$backup_root/$(date -u +%Y%m%dt%H%M%Sz)-XXXXXX")"
git rev-parse HEAD > "$backup/revision"

stage stop proxy
stage stop api worker
stage stop redis

stage exec -T postgres sh -ec \
  'exec pg_dump --format=custom --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  > "$backup/postgres.dump"
stage run --rm --no-deps -T --entrypoint tar redis -C /data -cf - . > "$backup/redis.tar"
stage exec -T postgres pg_restore --list < "$backup/postgres.dump" > /dev/null
tar -tf - < "$backup/redis.tar" > /dev/null
(cd "$backup" && sha256sum revision postgres.dump redis.tar > SHA256SUMS)

stage up -d --wait
printf 'Backup directory: %s\n' "$backup"
```

If the dump, archive, or verification fails, treat the directory as an
incomplete backup. Resume the original stack with `stage up -d --wait`
once you have checked the failure.
Keep successful backups encrypted in storage separate from the staging host.
Back up before upgrades and on a schedule that meets your recovery needs.
The archive format and restore options are documented in
[PostgreSQL 18 backup tools](https://www.postgresql.org/docs/18/app-pgdump.html).

## Restore into a fresh project

Start from the commit in `revision` and use the database name and role,
queue prefix, and webhook encryption key from that backup's deployment.
Set `backup` to the absolute path of the complete backup directory. The
commands create fresh volumes under a separate project name and bind HTTPS
to loopback on port 18443 for verification.

```bash
backup=/absolute/path/to/backup-directory
(cd "$backup" && sha256sum -c SHA256SUMS)
test "$(git rev-parse HEAD)" = "$(cat "$backup/revision")"

restore_project="resolve-restore-$(date -u +%Y%m%dt%H%M%Sz)-$$"
restore() {
  STAGING_BIND_IP=127.0.0.1 STAGING_HTTPS_PORT=18443 \
    docker compose --env-file "$staging_env" --project-name "$restore_project" \
    -f docker-compose.yml -f docker-compose.staging.yml "$@"
}
existing_volumes="$(docker volume ls --filter "label=com.docker.compose.project=$restore_project" -q)"
test -z "$existing_volumes"

restore up -d --wait postgres
restore exec -T postgres sh -ec \
  'exec pg_restore --single-transaction --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  < "$backup/postgres.dump"
restore run --rm --no-deps -T --entrypoint tar redis -C /data -xpf - < "$backup/redis.tar"
restore up -d --build --wait proxy
restore ps --all
```

Verify HTTPS readiness on port 18443, confirm the migration job exited with
code 0, then use an existing scoped key to read a known tenant's entity and
job. Compare their IDs and expected state with the checkpoint. Keep the
worker stopped for a drill with real data so restored webhook deliveries
stay queued. Use synthetic data to verify that a restored queued batch can
finish after running `restore up -d --build --wait worker`.

For recovery, stop the original ingress, API, and worker before promoting
the restored instance. Set the intended private binding in the staging env
file and point `stage` at the restored project so it continues using the
restored volumes.

```bash
stage stop proxy
stage stop api worker
stage_project="$restore_project"
stage up -d --no-deps --force-recreate proxy
```

Verify HTTPS readiness at the intended address. Review outstanding webhook
deliveries, then run `stage up -d --wait worker`. Deliveries made after the
backup can be sent again, and clients should deduplicate by event ID.
Record the active project name for subsequent deployments and backups.

For an upgrade rollback, use the previous commit and its pre-upgrade backup
if the old code cannot use the migrated schema. Changes accepted after that
checkpoint need to be reconciled separately. Keep the old volumes until you
have verified recovery. To stop a drill and preserve its volumes, run
`restore down`.
