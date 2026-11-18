#!/usr/bin/env bash
# Start the fan-twin broker in the foreground (Ctrl+C to stop).
set -euo pipefail
DIR="$(dirname "$(readlink -f "$0")")"
cd "$DIR"

if [[ ! -f passwd ]]; then
  echo "No passwd file yet - run ./setup_users.sh first." >&2
  exit 1
fi

mkdir -p data
chmod 600 passwd acl
sed "s|@DIR@|$DIR|g" mosquitto.conf.in > mosquitto.conf

IP=$(ip -4 -o addr show scope global 2>/dev/null | awk '!/docker|br-|veth/ {sub(/\/.*/,"",$4); print $4; exit}')
echo "Broker: mqtt://${IP:-<this-pc-ip>}:1883   ws://${IP:-<this-pc-ip>}:9001"
echo "        (put ${IP:-this IP} into firmware/fan_rpm/secrets.h as MQTT_HOST)"
exec mosquitto -c "$DIR/mosquitto.conf"
