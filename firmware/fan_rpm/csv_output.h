#pragma once
#include <Arduino.h>

// One 500 ms window, shared by the serial CSV and the MQTT JSON output.
struct Row {
  uint32_t t_ms, n;
  float mean[6], stdv[6], p2p[3];  // ax,ay,az,gx,gy,gz ; p2p only for accel
  float tempC;
  float shunt_mV, bus_V, load_V, current_mA;
  uint32_t inaAge_ms;
  bool inaFresh;
  float dsTempC;
  uint32_t dsAge_ms;
  uint8_t preset, duty;
  float rpm;
  bool settled;
};

void printCsvHeader();
void emitRow(uint32_t now);  // builds a Row from the current window, prints CSV + publishes MQTT
