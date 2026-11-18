#pragma once
#include <Arduino.h>

// ================= Pins =================
const uint8_t SDA_PIN = 21, SCL_PIN = 22;
const uint8_t DS_PIN = 4;
const uint8_t TACH_PIN = 25, PWM_PIN = 26;

// ================= Timing =================
const uint32_t MPU_SAMPLE_US = 2000;  // 500 Hz
const uint32_t WINDOW_MS = 500;       // one CSV row per 500 ms
const uint32_t INA_PERIOD_MS = 2000;
const uint8_t INA_SAMPLES = 20;
const uint32_t INA_SAMPLE_SPACING = INA_PERIOD_MS / INA_SAMPLES;
const uint32_t DS_PERIOD_MS = 2000;
const uint32_t DS_CONV_MS = 800;
const uint16_t CAL_SAMPLES = 500;
const uint32_t SETTLE_MS = 12000;  // P12 Pro kick-starts at LOW and takes ~11 s to settle
const uint32_t MPU_CHECK_MS = 1000;
// Tach: Arctic P12 Pro, max 3000 RPM, 2 pulses/rev -> shortest half-period ~5 ms.
// 1 ms min state time rejects edge wiggle/PWM spikes (tens of us) with 5x margin.
const uint32_t TACH_MIN_STATE_US = 1000;

// ================= MQTT =================
#define DEVICE_ID "fan01"
#define TOPIC_BASE "fantwin/" DEVICE_ID
const uint16_t MQTT_PORT = 1883;
const uint16_t MQTT_KEEPALIVE_S = 5;      // LWT fires ~1.5x this after power loss
const uint32_t MQTT_RETRY_MS = 5000;
