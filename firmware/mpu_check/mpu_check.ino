// Step 2: MPU6050 only. SDA=21, SCL=22, VCC=3V3. Serial Monitor @115200.
// Keep the board still: |a| should be close to 9.8 m/s^2. Tilt/tap it to see changes.
#include <Wire.h>
#include <math.h>

const uint8_t SDA_PIN = 21, SCL_PIN = 22, MPU = 0x68;
bool ready = false;
uint32_t errors = 0;

void wr(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

uint8_t rd(uint8_t reg) {
  Wire.beginTransmission(MPU);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom(MPU, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0xFF;
}

bool init_mpu() {
  uint8_t who = rd(0x75);
  Serial.printf("WHO_AM_I = 0x%02X\n", who);
  if (who != 0x68 && who != 0x70 && who != 0x71) {
    Serial.println("FAIL: no MPU answering. Run i2c_check to find the bad wire.");
    return false;
  }
  wr(0x6B, 0x80); delay(100);   // reset
  wr(0x6B, 0x01); delay(10);    // wake
  wr(0x1C, 0x10);               // +-8 g (same as main firmware)
  if (rd(0x1C) != 0x10) {
    Serial.println("FAIL: config write did not stick - loose wire or weak power.");
    return false;
  }
  Serial.println("PASS: MPU found and configured.");
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n===== MPU6050 check =====");
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000);
}

void loop() {
  if (!ready) {
    ready = init_mpu();
    if (!ready) delay(2000);
    return;
  }
  float sum[3] = { 0 }, sq = 0, tempC = 0;
  int n = 0;
  uint32_t start = millis();
  while (millis() - start < 500) {
    Wire.beginTransmission(MPU);
    Wire.write(0x3B);
    if (Wire.endTransmission(false) != 0 || Wire.requestFrom(MPU, (uint8_t)8) != 8) {
      errors++;
      delay(5);
      continue;
    }
    int16_t r[4];
    for (int i = 0; i < 4; i++) r[i] = (Wire.read() << 8) | Wire.read();
    float a[3];
    for (int i = 0; i < 3; i++) { a[i] = r[i] / 4096.0f * 9.80665f; sum[i] += a[i]; }
    sq += a[0] * a[0];
    tempC = r[3] / 333.87f + 21.0f;
    n++;
    delay(2);
  }
  if (n == 0) {
    Serial.println("FAIL: reads stopped (loose wire?) - re-initialising");
    ready = false;
    return;
  }
  float x = sum[0] / n, y = sum[1] / n, z = sum[2] / n;
  float mag = sqrtf(x * x + y * y + z * z);
  float stdx = sqrtf(fmaxf(0, sq / n - x * x));
  Serial.printf("ax=%6.2f ay=%6.2f az=%6.2f |a|=%5.2f  ax_std=%.4f  T=%.1fC  errors=%lu  %s\n",
                x, y, z, mag, stdx, tempC, (unsigned long)errors,
                (mag > 8.8 && mag < 10.8) ? "OK" : "CHECK (moving, or bad data)");
}
