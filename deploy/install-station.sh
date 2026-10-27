#!/usr/bin/env bash
# Installs or refreshes an Order Pad station from a verified GitHub release. Safe to rerun:
# an installed station only gets its systemd units and helper commands refreshed.
# It never creates, stops or changes PostgreSQL; set that up first (README "Set up a station").
set -euo pipefail

REPO=castab/event-order-pad
COSIGN_VERSION=3.1.3
COSIGN_SHA256=75357d96161da4d06d37c4b2831fa6978483cdce661999e5951b586f9ee1d710
ROOT=/opt/order-pad
ETC=/etc/order-pad
STATE=/var/lib/order-pad/updater

usage() {
  cat <<'USAGE'
Usage: sudo ./install-station.sh --release vX.Y.Z [options]
  --adopt-env FILE   Start /etc/order-pad/order-pad.env from an existing .env
                     (POSTGRES_* and TEST_DATABASE_URL lines are left out)
  --replace-unit     Move an existing order-pad.service (and its drop-ins) to
                     /etc/order-pad/previous-unit/ and stop it. Do this when idle.
  --enable-timer     Start automatic updates (order-pad-update.timer)
  --verify sha256    Check the checksum only, without cosign
USAGE
  exit 2
}
fail() {
  echo "install-station: $*" >&2
  exit 1
}

TAG='' ADOPT='' REPLACE=0 TIMER=0 VERIFY=sigstore
while [ $# -gt 0 ]; do
  case "$1" in
    --release) TAG=${2:-}; shift 2 ;;
    --adopt-env) ADOPT=${2:-}; shift 2 ;;
    --replace-unit) REPLACE=1; shift ;;
    --enable-timer) TIMER=1; shift ;;
    --verify) VERIFY=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done
[[ $TAG =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || usage
[[ $VERIFY == sigstore || $VERIFY == sha256 ]] || usage
[ "$(id -u)" -eq 0 ] || fail 'run as root (sudo).'
[ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || fail 'stations must be x86-64 Linux.'
command -v systemctl >/dev/null || fail 'systemd is required.'

if command -v apt-get >/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl fonts-dejavu-core >/dev/null
fi
if [ "$VERIFY" = sigstore ] &&
  ! cosign version 2>/dev/null | grep -q "v$COSIGN_VERSION"; then
  deb=$(mktemp --suffix=.deb)
  curl -fsSL -o "$deb" \
    "https://github.com/sigstore/cosign/releases/download/v$COSIGN_VERSION/cosign_${COSIGN_VERSION}_amd64.deb"
  echo "$COSIGN_SHA256  $deb" | sha256sum --check --quiet || fail 'cosign download does not match its checksum.'
  dpkg -i "$deb" >/dev/null
  rm -f "$deb"
fi

id order-pad >/dev/null 2>&1 ||
  useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin order-pad
install -d -m 0755 "$ROOT/releases" "$STATE" "$ETC"
install -d -m 0700 /var/backups/order-pad

release="$ROOT/releases/$TAG"
if [ ! -f "$release/release.json" ]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  name="order-pad-$TAG-linux-x64.tar.gz"
  for asset in "$name" SHA256SUMS "$name.sigstore.json"; do
    curl -fsSL -o "$work/$asset" "https://github.com/$REPO/releases/download/$TAG/$asset"
  done
  (cd "$work" && sha256sum --check --quiet SHA256SUMS) || fail "$name does not match SHA256SUMS."
  if [ "$VERIFY" = sigstore ]; then
    escaped=$(printf '%s' "https://github.com/$REPO/.github/workflows/release.yml@refs/tags/$TAG" | sed 's/[.]/\\./g')
    # By digest: cosign refuses to read blobs over 128 MiB, and the tarball is larger.
    digest=$(sha256sum "$work/$name" | cut -d' ' -f1)
    cosign verify-blob-attestation --bundle "$work/$name.sigstore.json" --type slsaprovenance1 \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      --certificate-identity-regexp "^$escaped\$" --digest "$digest" --digestAlg sha256 >/dev/null ||
      fail "$name was not built by $REPO's release workflow at $TAG."
  fi
  rm -rf "$release.partial"
  install -d -m 0755 "$release.partial"
  tar --extract --gzip --no-same-owner --strip-components=1 --file "$work/$name" --directory "$release.partial"
  mv "$release.partial" "$release"
  echo "Verified and unpacked $TAG."
fi

if [ ! -f "$ETC/order-pad.env" ]; then
  if [ -n "$ADOPT" ]; then
    grep -Ev '^\s*(POSTGRES_[A-Z_]+|TEST_DATABASE_URL)=' "$ADOPT" >"$ETC/order-pad.env"
  else
    grep -Ev '^\s*(POSTGRES_[A-Z_]+|TEST_DATABASE_URL)=' "$release/.env.example" >"$ETC/order-pad.env"
    touch "$ETC/.edit-env"
  fi
  chown root:order-pad "$ETC/order-pad.env"
  chmod 0640 "$ETC/order-pad.env"
fi
if [ ! -f "$ETC/updater.conf" ]; then
  sed "s#^TIME_ZONE=.*#TIME_ZONE=$(timedatectl show --property=Timezone --value 2>/dev/null || echo UTC)#" \
    "$release/deploy/updater.conf.example" >"$ETC/updater.conf"
  touch "$ETC/.edit-updater"
fi
if [ -e "$ETC/.edit-env" ] || [ -e "$ETC/.edit-updater" ]; then
  echo "Review $ETC/order-pad.env and $ETC/updater.conf (BACKUP_COMMAND names your"
  echo "PostgreSQL container), delete $ETC/.edit-env and $ETC/.edit-updater, then rerun."
  exit 3
fi

unit=/etc/systemd/system/order-pad.service
if [ -e "$unit" ] && ! cmp -s "$unit" "$release/deploy/systemd/order-pad.service" &&
  ! grep -q '^WorkingDirectory=/opt/order-pad/current$' "$unit"; then
  [ "$REPLACE" -eq 1 ] || fail "$unit is not the release unit. Rerun with --replace-unit when the station is idle."
  systemctl stop order-pad.service || true
  install -d -m 0755 "$ETC/previous-unit"
  mv "$unit" "$ETC/previous-unit/"
  [ -d "$unit.d" ] && mv "$unit.d" "$ETC/previous-unit/"
  echo "Moved the previous unit to $ETC/previous-unit/."
fi
current="$ROOT/current"
units="$release/deploy/systemd"
[ -L "$current" ] && units="$current/deploy/systemd"
install -m 0644 "$units/order-pad.service" "$units/order-pad-update.service" \
  "$units/order-pad-update.timer" /etc/systemd/system/
cat >/usr/local/sbin/order-pad-ops <<'OPS'
#!/bin/sh
# Changes take the same lock as the update timer; reports do not.
case "$1" in
  status | check | idle) exec /opt/order-pad/current/node/bin/node /opt/order-pad/current/build-printer/ops.mjs "$@" ;;
esac
exec /usr/bin/flock --nonblock --conflict-exit-code 75 /run/lock/order-pad-update.lock \
  /opt/order-pad/current/node/bin/node /opt/order-pad/current/build-printer/ops.mjs "$@"
OPS
cat >/usr/local/sbin/order-pad-access <<'ACCESS'
#!/bin/sh
cd /opt/order-pad/current || exit 1
exec runuser -u order-pad -- /opt/order-pad/current/node/bin/node \
  --env-file=/etc/order-pad/order-pad.env build-printer/access-cli.mjs "$@"
ACCESS
chmod 0755 /usr/local/sbin/order-pad-ops /usr/local/sbin/order-pad-access
systemctl daemon-reload
systemctl enable order-pad.service >/dev/null

if [ ! -L "$current" ]; then
  /usr/bin/flock --nonblock /run/lock/order-pad-update.lock \
    "$release/node/bin/node" "$release/build-printer/ops.mjs" apply "$TAG" --initial
else
  echo "$(basename "$(readlink "$current")") is installed; refreshed units and helper commands."
fi
if [ "$TIMER" -eq 1 ]; then
  systemctl enable --now order-pad-update.timer >/dev/null
  echo 'Automatic updates are on.'
fi
order-pad-ops status
