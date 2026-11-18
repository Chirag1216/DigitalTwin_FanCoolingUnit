#include "fan_control.h"
#include "config.h"
#include "mqtt_link.h"

uint8_t presetIdx = 0;
uint32_t presetSetMs = 0;

static volatile uint32_t tachCount = 0, lastEdgeUs = 0;
static volatile bool tachHigh = true;
static portMUX_TYPE tachMux = portMUX_INITIALIZER_UNLOCKED;

// Software hysteresis: the tach line must stay in a state for TACH_MIN_STATE_US
// before the opposite transition is accepted, and a pulse is counted only on an
// accepted HIGH->LOW. The slow RC-filtered edge (ESP32 inputs have no Schmitt
// trigger) can wiggle through the threshold on the *rising* edge; the old
// FALLING + 2 ms debounce counted that wiggle as a second pulse -> RPM read 2x.
static void IRAM_ATTR tachISR() {
  uint32_t now = micros();
  bool high = digitalRead(TACH_PIN);
  portENTER_CRITICAL_ISR(&tachMux);
  if (high != tachHigh && now - lastEdgeUs >= TACH_MIN_STATE_US) {
    tachHigh = high;
    lastEdgeUs = now;
    if (!high) tachCount++;
  }
  portEXIT_CRITICAL_ISR(&tachMux);
}

void fanInit() {
  ledcAttach(PWM_PIN, 25000, 8);
  setPreset(0);  // fan OFF for calibration
  pinMode(TACH_PIN, INPUT_PULLUP);
  tachHigh = digitalRead(TACH_PIN);
  attachInterrupt(digitalPinToInterrupt(TACH_PIN), tachISR, CHANGE);
}

uint32_t takeTachCount() {
  portENTER_CRITICAL(&tachMux);
  uint32_t c = tachCount;
  tachCount = 0;
  portEXIT_CRITICAL(&tachMux);
  return c;
}

void setPreset(uint8_t idx) {
  if (idx >= NUM_PRESETS) return;
  presetIdx = idx;
  presetSetMs = millis();
  ledcWrite(PWM_PIN, PRESETS[idx].duty * 255 / 100);
  Serial.printf("# preset %u (%s) -> duty %u%%\n", idx, PRESETS[idx].name, PRESETS[idx].duty);
  mqttNotifyStatus();
}
