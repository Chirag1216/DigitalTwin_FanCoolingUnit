#pragma once
#include <Arduino.h>

// INA219: accumulates samples and publishes an averaged reading.
extern float ffShunt_mV, ffBus_V, ffLoad_V, ffCurrent_mA;
extern uint32_t ffInaTimeMs;
extern bool inaFresh;  // set on each new average, cleared after it is printed

bool inaBegin();
void sampleIna();
void updateIna();  // average the accumulated samples into ff* values
bool inaBatchFull();
