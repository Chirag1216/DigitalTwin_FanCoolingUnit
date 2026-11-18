#include "imu.h"
#include "config.h"
#include <Wire.h>

static const uint8_t MPU_ADDR = 0x68;
static const float ACC_LSB_PER_G = 4096.0f, GYRO_LSB_PER_DPS = 65.5f;
static const float G_MS2 = 9.80665f, DEG2RAD = 0.01745329252f;

float bias[6] = { 0 };
AxisStats win[6];
double tempSum = 0;
uint32_t winN = 0;

static void mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}
static uint8_t mpuRead8(uint8_t reg) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom(MPU_ADDR, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0xFF;
}
uint8_t mpuWhoAmI() {
  return mpuRead8(0x75);
}
bool mpuInit() {
  uint8_t who = mpuRead8(0x75);
  if (who != 0x68 && who != 0x70 && who != 0x71) return false;
  mpuWrite(0x6B, 0x80);
  delay(100);
  mpuWrite(0x6B, 0x01);
  delay(10);
  mpuWrite(0x19, 0x01);  // 500 Hz
  mpuWrite(0x1A, 0x01);  // gyro DLPF ~184 Hz
  mpuWrite(0x1B, 0x08);  // ±500 dps
  mpuWrite(0x1C, 0x10);  // ±8 g
  mpuWrite(0x1D, 0x01);  // accel DLPF ~218 Hz
  return mpuConfigOk();
}
bool mpuConfigOk() {
  return mpuRead8(0x1C) == 0x10;
}
bool mpuReadAll(float v[6], float &tempC) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MPU_ADDR, (uint8_t)14) != 14) return false;
  int16_t r[7];
  for (int i = 0; i < 7; i++) r[i] = (Wire.read() << 8) | Wire.read();
  v[0] = r[0] / ACC_LSB_PER_G * G_MS2;
  v[1] = r[1] / ACC_LSB_PER_G * G_MS2;
  v[2] = r[2] / ACC_LSB_PER_G * G_MS2;
  tempC = r[3] / 333.87f + 21.0f;
  v[3] = r[4] / GYRO_LSB_PER_DPS * DEG2RAD;
  v[4] = r[5] / GYRO_LSB_PER_DPS * DEG2RAD;
  v[5] = r[6] / GYRO_LSB_PER_DPS * DEG2RAD;
  return true;
}
void calibrate() {
  double s[6] = { 0 };
  uint16_t n = 0;
  uint32_t next = micros();
  while (n < CAL_SAMPLES) {
    if ((int32_t)(micros() - next) >= 0) {
      next += MPU_SAMPLE_US;
      float v[6], t;
      if (mpuReadAll(v, t)) {
        for (int i = 0; i < 6; i++) s[i] += v[i];
        n++;
      }
    }
  }
  for (int i = 0; i < 6; i++) bias[i] = s[i] / n;
  bias[2] -= G_MS2;
}

void resetWindow() {
  for (auto &a : win) {
    a.sum = 0;
    a.sumSq = 0;
    a.mn = 1e9f;
    a.mx = -1e9f;
  }
  tempSum = 0;
  winN = 0;
}
void addSample(const float v[6], float tC) {
  for (int i = 0; i < 6; i++) {
    win[i].sum += v[i];
    win[i].sumSq += (double)v[i] * v[i];
    if (v[i] < win[i].mn) win[i].mn = v[i];
    if (v[i] > win[i].mx) win[i].mx = v[i];
  }
  tempSum += tC;
  winN++;
}
