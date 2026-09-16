#!/bin/sh
# Every operator task, from the one image that is already deployed.
#
# This is what makes a Compose-only deployment complete: there is no host with
# Node on it to run a script from, so anything an operator may have to do —
# claim a fresh instance, recover an account nobody can sign into, rebuild the
# derived index, take a backup, put one back — has to be reachable as
# `compose run --rm app <command>`.
#
# `create-admin` exists because a fresh volume has no accounts and registration
# is closed by default — so there must be a way in that does not require the
# very session it is trying to create. `reset-password` is the same hole from
# the other end: every other reset path needs an admin session, so a forgotten
# administrator password would otherwise mean editing JSON under /data by hand.
# Both read the password from stdin, never from an argument, so it does not land
# in shell history, in `ps`, or in `docker inspect`.
set -e

case "${1:-serve}" in
  serve)
    exec node dist/server/index.js
    ;;
  create-admin)
    shift
    # e.g.  docker run -i --rm -v chatui-data:/data IMAGE create-admin --username alice --admin
    exec node dist/server/scripts/createUser.js "$@"
    ;;
  rebuild-index)
    shift
    # The index is derived, never a source of truth (INV-11): deleting it loses
    # nothing and this rebuilds it from the canonical Markdown. Needed after
    # restoring a backup taken from a different layout, or after editing files
    # under /data by hand.
    exec node dist/server/scripts/rebuildIndex.js "$@"
    ;;
  backup)
    # The whole persistent boundary, as a tar stream on stdout.
    #
    # stdout rather than a file inside the container, so the archive lands
    # wherever the operator redirects it and nothing has to be copied out of a
    # container afterwards. Everything under /data is included — accounts,
    # conversations, attachments, memories, artifacts, providers, settings —
    # because the boundary is the unit that is consistent with itself; backing
    # up a subset of it produces a restore that half works.
    #
    # Stop the server first if you want a quiet archive. A running server is
    # writing files atomically (temp then rename), so a hot copy is readable,
    # but a conversation written during the copy may or may not be in it.
    if [ ! -d /data ]; then
      echo "backup: /data is not mounted" >&2
      exit 1
    fi
    exec tar -C /data -cf - .
    ;;
  restore)
    # The inverse: a tar stream on stdin, unpacked into /data.
    #
    # Refused unless /data is empty, because the alternative is a half-merged
    # directory holding two deployments' files with no way to tell them apart.
    # Emptying it is the operator's decision to make explicitly:
    #   compose down -v && compose up -d --no-start
    if [ ! -d /data ]; then
      echo "restore: /data is not mounted" >&2
      exit 1
    fi
    if [ -n "$(ls -A /data 2>/dev/null)" ]; then
      echo "restore: /data is not empty; refusing to merge into an existing deployment" >&2
      echo "         remove the volume first (compose down -v), then restore." >&2
      exit 1
    fi
    tar -C /data -xf -
    echo "restore: unpacked into /data" >&2
    ;;
  reset-password)
    shift
    # e.g.  printf 'new-password\n' | docker run -i --rm -v chatui-data:/data IMAGE \
    #         reset-password --username alice
    # Existing sessions are revoked unless --keep-sessions is passed.
    exec node dist/server/scripts/setPassword.js "$@"
    ;;
  healthcheck)
    # What the image's HEALTHCHECK runs.
    #
    # It lives here, next to the command it is checking on, because it has to
    # agree with it about two things the operator chooses: the port, and
    # whether the listener is HTTP or HTTPS. A probe that hard-codes either one
    # reports a healthy server as unhealthy the moment the operator configures
    # TLS — which `docker-compose.yml` invites them to do.
    exec node -e '
      const tls = Boolean(process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE);
      const lib = require(tls ? "node:https" : "node:http");
      const req = lib.request(
        {
          host: "127.0.0.1",
          port: process.env.PORT || 3001,
          path: "/api/health",
          timeout: 4000,
          // This is our own listener over the loopback, and the certificate on
          // it is very often self-signed or issued for the public hostname
          // rather than 127.0.0.1. Verifying it here would report on the
          // operator’s PKI instead of on whether the server is up.
          rejectUnauthorized: false,
        },
        (res) => {
          res.resume();
          process.exit(res.statusCode === 200 ? 0 : 1);
        }
      );
      req.on("error", () => process.exit(1));
      req.on("timeout", () => {
        req.destroy();
        process.exit(1);
      });
      req.end();
    '
    ;;
  *)
    # Anything else is run verbatim, so `docker run IMAGE node -v` and the like
    # still work for debugging.
    exec "$@"
    ;;
esac
