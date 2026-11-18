#pragma once
#include <Arduino.h>

// MPU6050/6500 raw register driver + per-window statistics.
// Axis order everywhere: ax, ay, az (m/s^2), gx, gy, gz (rad/s).

struct AxisStats {
  double sum, sumSq;
  float mn, mx;
};

extern float bias[6];
extern AxisStats win[6];
extern double tempSum;
extern uint32_t winN;

bool mpuInit();
uint8_t mpuWhoAmI();  // raw WHO_AM_I (0xFF = no reply)
bool mpuConfigOk();  // false if the sensor lost its config (e.g. brown-out)
bool mpuReadAll(float v[6], float &tempC);
void calibrate();  // fills bias[]; device must be still

void resetWindow();
void addSample(const float v[6], float tC);
