#pragma once
// Copy this file to secrets.h (same folder) and fill in your values.
// secrets.h is git-ignored - never commit real credentials.
#define WIFI_SSID "your-2.4GHz-ssid"
#define WIFI_PASS "your-wifi-password"
#define MQTT_HOST "192.168.1.100"  // LAN IP of the PC running the broker (start_broker.sh prints it)
#define MQTT_USER "fan01"          // broker user for the ESP32 (see broker/setup_users.sh)
#define MQTT_PASS "fan01-password"
