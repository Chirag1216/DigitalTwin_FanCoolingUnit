#include <Wire.h>
#include "config.h"
#include "fan_control.h"
#include "imu.h"
#include "power_monitor.h"
#include "temp_sensor.h"
#include "serial_cmd.h"
#include "csv_output.h"
#include "mqtt_link.h"

uint32_t nextSampleUs = 0, windowStartMs = 0, lastInaSampleMs = 0, lastMpuCheckMs = 0;

void setup() {
  Serial.setTxBufferSize(1024);
  Serial.begin(115200);
  delay(1000);

  fanInit();

  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000);
  delay(100);

  if (!inaBegin()) {
    Serial.println("# INA219 not found - power columns will be nan (continuing)");
  }
  if (!mpuInit()) {
    Serial.printf("# MPU not found / config failed (WHO_AM_I=0x%02X)\n", mpuWhoAmI());
    Serial.print("# I2C devices found:");
    uint8_t found = 0;
    for (uint8_t a = 1; a < 127; a++) {
      Wire.beginTransmission(a);
      if (Wire.endTransmission() == 0) {
        Serial.printf(" 0x%02X", a);
        found++;
      }
    }
    Serial.println(found ? "" : " none - check SDA=21, SCL=22, VCC=3.3V, GND");
    while (1) delay(10);
  }
  dsInit();

  Serial.println("# Calibrating - keep everything still...");
  delay(3000);  // let the fan fully stop
  calibrate();
  Serial.printf("# Bias ax=%.3f ay=%.3f az=%.3f gx=%.4f gy=%.4f gz=%.4f\n",
                bias[0], bias[1], bias[2], bias[3], bias[4], bias[5]);
  Serial.println("# Ready. Presets: p 0=OFF p 1=LOW p 2=MEDIUM p 3=HIGH p 4=MAX");

  mqttInit();  // WiFi + MQTT task on core 0 (after calibration so radio noise doesn't affect bias)

  sampleIna();
  updateIna();

  printCsvHeader();

  resetWindow();
  takeTachCount();
  nextSampleUs = micros();
  windowStartMs = lastInaSampleMs = lastMpuCheckMs = millis();
}

void loop() {
  uint32_t nowUs = micros();
  if ((int32_t)(nowUs - nextSampleUs) >= 0) {
    nextSampleUs += MPU_SAMPLE_US;
    if ((int32_t)(nowUs - nextSampleUs) > (int32_t)(10 * MPU_SAMPLE_US)) nextSampleUs = nowUs + MPU_SAMPLE_US;
    float v[6], t;
    if (mpuReadAll(v, t)) {
      for (int i = 0; i < 6; i++) v[i] -= bias[i];
      addSample(v, t);
    }
  }

  uint32_t now = millis();

  if (now - lastInaSampleMs >= INA_SAMPLE_SPACING) {
    lastInaSampleMs += INA_SAMPLE_SPACING;
    sampleIna();
    if (inaBatchFull()) updateIna();
  }

  dsUpdate(now);
  handleSerial();

  int webPreset = mqttTakeCommand();
  if (webPreset >= 0) setPreset(webPreset);

  static bool wasConnected = false;
  bool isConnected = mqttConnected();
  if (isConnected != wasConnected) {
    wasConnected = isConnected;
    Serial.println(isConnected ? "# MQTT connected" : "# MQTT disconnected");
  }

  if (now - lastMpuCheckMs >= MPU_CHECK_MS) {
    lastMpuCheckMs = now;
    if (!mpuConfigOk()) {
      Serial.println("# MPU config lost - re-initialising");
      mpuInit();
      resetWindow();
    }
  }

  if (now - windowStartMs >= WINDOW_MS) {
    windowStartMs += WINDOW_MS;
    emitRow(now);
    resetWindow();
  }
}
