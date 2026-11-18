#pragma once
#include <Arduino.h>

// DS18B20: non-blocking conversions every DS_PERIOD_MS.
extern float ffDsTempC;  // NAN until the first valid reading
extern uint32_t ffDsTimeMs;

void dsInit();
void dsUpdate(uint32_t now);
