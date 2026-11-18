#pragma once
#include <Arduino.h>
#include "csv_output.h"

// WiFi + MQTT run in their own FreeRTOS task on core 0, so a slow/blocked
// broker connect can never stall the 500 Hz IMU loop running on core 1.
//
// Topics (TOPIC_BASE = fantwin/<DEVICE_ID>):
//   /telemetry  out  JSON row every 500 ms
//   /status     out  retained {"online":true,"preset":..}; LWT {"online":false}
//   /cmd        in   {"preset":N}  or  N        (0..NUM_PRESETS-1)
//   /event      out  info / rejected-command messages

void mqttInit();                      // call once after calibration
void mqttPublishRow(const Row &r);    // non-blocking; drops the row if the queue is full
void mqttNotifyStatus();              // republish retained status (called by setPreset)
int mqttTakeCommand();                // pending preset from web, or -1 (call from loop())
bool mqttConnected();
