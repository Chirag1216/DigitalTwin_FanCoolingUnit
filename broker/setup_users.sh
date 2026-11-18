#!/usr/bin/env bash
# Create/replace the broker users: fan01 (ESP32), twin (service), web (dashboard).
# Run once, or again to change passwords. Passwords are hashed into ./passwd.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

USERS=(fan01 twin web)
rm -f passwd.tmp
touch passwd.tmp
chmod 600 passwd.tmp

for u in "${USERS[@]}"; do
  while true; do
    read -rsp "Password for '$u': " p1; echo
    read -rsp "Repeat password for '$u': " p2; echo
    [[ -n "$p1" && "$p1" == "$p2" ]] && break
    echo "  empty or not matching - try again"
  done
  mosquitto_passwd -b passwd.tmp "$u" "$p1"
done

mv passwd.tmp passwd
echo "Wrote $(pwd)/passwd for: ${USERS[*]}"
echo "Put the fan01 password into firmware/fan_rpm/secrets.h (MQTT_USER \"fan01\", MQTT_PASS \"...\")."
echo "If the broker is running, restart it (or: kill -HUP <pid>) to reload users."
