#include "power_monitor.h"
#include "config.h"
#include <Adafruit_INA219.h>
#include <math.h>

static Adafruit_INA219 ina;
static bool inaOk = false;
static float accCurrent = 0, accShunt = 0, accBus = 0;
static uint8_t accCount = 0;

// NaN until a real reading exists -> "nan" in CSV, null in MQTT JSON
float ffShunt_mV = NAN, ffBus_V = NAN, ffLoad_V = NAN, ffCurrent_mA = NAN;
uint32_t ffInaTimeMs = 0;
bool inaFresh = false;

bool inaBegin() {
  inaOk = ina.begin();
  return inaOk;
}
void sampleIna() {
  if (!inaOk) return;
  accCurrent += ina.getCurrent_mA();
  accShunt += ina.getShuntVoltage_mV();
  accBus += ina.getBusVoltage_V();
  accCount++;
}
void updateIna() {
  if (!accCount) return;
  ffShunt_mV = accShunt / accCount;
  ffBus_V = accBus / accCount;
  ffCurrent_mA = accCurrent / accCount;
  ffLoad_V = ffBus_V + ffShunt_mV / 1000.0f;
  ffInaTimeMs = millis();
  inaFresh = true;
  accCurrent = accShunt = accBus = 0;
  accCount = 0;
}
bool inaBatchFull() {
  return accCount >= INA_SAMPLES;
}
