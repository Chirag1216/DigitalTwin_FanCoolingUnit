#include "serial_cmd.h"
#include <Arduino.h>
#include "fan_control.h"

static char cmdBuf[16];
static uint8_t cmdLen = 0;

void handleSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (cmdLen) {
        cmdBuf[cmdLen] = 0;
        if (cmdBuf[0] == 'p' || cmdBuf[0] == 'P') setPreset(atoi(cmdBuf + 1));
        cmdLen = 0;
      }
    } else if (cmdLen < sizeof(cmdBuf) - 1) cmdBuf[cmdLen++] = c;
  }
}
