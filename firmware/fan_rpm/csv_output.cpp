#include "csv_output.h"
#include "config.h"
#include "fan_control.h"
#include "imu.h"
#include "power_monitor.h"
#include "temp_sensor.h"
#include "mqtt_link.h"
#include <math.h>

void printCsvHeader() {
  Serial.println("t_ms,n,"
                 "ax_mean,ay_mean,az_mean,ax_std,ay_std,az_std,ax_p2p,ay_p2p,az_p2p,"
                 "gx_mean,gy_mean,gz_mean,gx_std,gy_std,gz_std,temp_C,"
                 "shunt_mV,bus_V,load_V,current_mA,ina_age_ms,ina_fresh,"
                 "ds_temp_C,ds_age_ms,preset,duty_pct,rpm,settled");
}

static void printCsvRow(const Row &r) {
  Serial.printf("%lu,%lu,", r.t_ms, r.n);
  Serial.printf("%.3f,%.3f,%.3f,", r.mean[0], r.mean[1], r.mean[2]);
  Serial.printf("%.4f,%.4f,%.4f,", r.stdv[0], r.stdv[1], r.stdv[2]);
  Serial.printf("%.4f,%.4f,%.4f,", r.p2p[0], r.p2p[1], r.p2p[2]);
  Serial.printf("%.4f,%.4f,%.4f,", r.mean[3], r.mean[4], r.mean[5]);
  Serial.printf("%.4f,%.4f,%.4f,", r.stdv[3], r.stdv[4], r.stdv[5]);
  Serial.printf("%.2f,", r.tempC);
  Serial.printf("%.3f,%.3f,%.3f,%.2f,", r.shunt_mV, r.bus_V, r.load_V, r.current_mA);
  Serial.printf("%lu,%d,", r.inaAge_ms, r.inaFresh ? 1 : 0);
  Serial.printf("%.2f,%lu,", r.dsTempC, r.dsAge_ms);
  Serial.printf("%u,%u,%.0f,%d\n", r.preset, r.duty, r.rpm, r.settled ? 1 : 0);
}

void emitRow(uint32_t now) {
  float rpm = takeTachCount() * (60000.0f / WINDOW_MS) / PULSES_PER_REV;
  if (winN == 0) return;

  Row r;
  r.t_ms = now;
  r.n = winN;
  for (int i = 0; i < 6; i++) {
    double m = win[i].sum / winN, var = win[i].sumSq / winN - m * m;
    r.mean[i] = m;
    r.stdv[i] = sqrt(var > 0 ? var : 0);
    if (i < 3) r.p2p[i] = win[i].mx - win[i].mn;
  }
  r.tempC = tempSum / winN;
  r.shunt_mV = ffShunt_mV;
  r.bus_V = ffBus_V;
  r.load_V = ffLoad_V;
  r.current_mA = ffCurrent_mA;
  r.inaAge_ms = now - ffInaTimeMs;
  r.inaFresh = inaFresh;
  r.dsTempC = ffDsTempC;
  r.dsAge_ms = now - ffDsTimeMs;
  r.preset = presetIdx;
  r.duty = PRESETS[presetIdx].duty;
  r.rpm = rpm;
  r.settled = (now - presetSetMs) >= SETTLE_MS;

  printCsvRow(r);
  mqttPublishRow(r);
  inaFresh = false;
}
