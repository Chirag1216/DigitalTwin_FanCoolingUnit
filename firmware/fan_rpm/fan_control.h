#pragma once
#include <Arduino.h>

struct Preset {
  const char *name;
  uint8_t duty;
};
constexpr Preset PRESETS[] = { { "OFF", 0 }, { "LOW", 30 }, { "MEDIUM", 50 }, { "HIGH", 70 }, { "MAX", 90 } };
constexpr uint8_t NUM_PRESETS = sizeof(PRESETS) / sizeof(PRESETS[0]);
const uint8_t PULSES_PER_REV = 2;

extern uint8_t presetIdx;
extern uint32_t presetSetMs;

void fanInit();  // PWM + tach interrupt, starts at preset 0 (OFF)
void setPreset(uint8_t idx);
uint32_t takeTachCount();  // returns pulses since last call and resets the counter
