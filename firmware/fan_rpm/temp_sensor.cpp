#include "temp_sensor.h"
#include "config.h"
#include <OneWire.h>
#include <DallasTemperature.h>
#include <math.h>

static OneWire oneWire(DS_PIN);
static DallasTemperature ds(&oneWire);
static DeviceAddress dsAddr;
static bool dsFound = false, dsPending = false;
static uint32_t dsRequestMs = 0;

float ffDsTempC = NAN;
uint32_t ffDsTimeMs = 0;

void dsInit() {
  ds.begin();
  dsFound = ds.getAddress(dsAddr, 0);
  if (!dsFound) {
    Serial.println("# DS18B20 not found - ds_temp_C will be nan");
    return;
  }
  ds.setResolution(dsAddr, 12);
  ds.setWaitForConversion(true);
  ds.requestTemperaturesByAddress(dsAddr);
  float t = ds.getTempC(dsAddr);
  if (t != DEVICE_DISCONNECTED_C) {
    ffDsTempC = t;
    ffDsTimeMs = millis();
  }
  ds.setWaitForConversion(false);
  ds.requestTemperaturesByAddress(dsAddr);
  dsRequestMs = millis();
  dsPending = true;
}
void dsUpdate(uint32_t now) {
  if (!dsFound) return;
  if (dsPending && now - dsRequestMs >= DS_CONV_MS) {
    float t = ds.getTempC(dsAddr);
    if (t != DEVICE_DISCONNECTED_C && t != 85.0f) {
      ffDsTempC = t;
      ffDsTimeMs = now;
    }
    dsPending = false;
  }
  if (!dsPending && now - dsRequestMs >= DS_PERIOD_MS) {
    dsRequestMs += DS_PERIOD_MS;
    ds.requestTemperaturesByAddress(dsAddr);
    dsPending = true;
  }
}
