// Step 4: fan only. PWM=GPIO26, TACH=GPIO25, 12 V supply on, grounds joined. Serial @115200.
// Sweeps OFF..MAX once and prints a verdict per step. Afterwards type 0-4 to hold a
// preset, or s to sweep again.
const uint8_t TACH_PIN = 25, PWM_PIN = 26;
const uint8_t DUTY[5] = { 0, 30, 50, 70, 90 };
const int EXPECT[5] = { 0, 1140, 1680, 2220, 2760 };
const char *NAME[5] = { "OFF", "LOW", "MEDIUM", "HIGH", "MAX" };

volatile uint32_t pulses = 0, lastEdgeUs = 0;
volatile bool tachHigh = true;

// same edge filter as the main firmware
void IRAM_ATTR tachISR() {
  uint32_t now = micros();
  bool high = digitalRead(TACH_PIN);
  if (high != tachHigh && now - lastEdgeUs >= 1000) {
    tachHigh = high;
    lastEdgeUs = now;
    if (!high) pulses++;
  }
}

void setFan(int p) {
  ledcWrite(PWM_PIN, DUTY[p] * 255 / 100);
  Serial.printf("\n--- %s (duty %u%%, expect ~%d RPM) ---\n", NAME[p], DUTY[p], EXPECT[p]);
}

int measure(uint32_t ms) {
  noInterrupts(); pulses = 0; interrupts();
  delay(ms);
  noInterrupts(); uint32_t c = pulses; interrupts();
  return c * (60000UL / ms) / 2;  // 2 pulses per revolution
}

void sweep() {
  int result[5];
  for (int p = 0; p < 5; p++) {
    setFan(p);
    for (int s = 1; s <= 14; s++) {
      result[p] = measure(1000);
      Serial.printf("  %2ds  %d RPM\n", s, result[p]);
    }
  }
  setFan(0);
  Serial.println("\n===== SUMMARY =====");
  for (int p = 0; p < 5; p++) {
    bool ok = p == 0 ? result[p] < 50 : abs(result[p] - EXPECT[p]) <= EXPECT[p] * 0.15;
    Serial.printf("%-7s %5d RPM  %s\n", NAME[p], result[p], ok ? "PASS" : "FAIL");
  }
  Serial.println("If something failed:\n"
                 "  0 RPM, fan spinning      -> tach wire / pull-up / series resistor to GPIO25\n"
                 "  0 RPM, fan not spinning  -> 12 V supply or common ground\n"
                 "  speed never changes      -> PWM wire (GPIO26) or common ground\n"
                 "  about double or jumpy    -> 10 nF capacitor on the tach filter\n"
                 "Type 0-4 to hold a preset, s to sweep again.");
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  ledcAttach(PWM_PIN, 25000, 8);
  ledcWrite(PWM_PIN, 0);
  pinMode(TACH_PIN, INPUT_PULLUP);
  tachHigh = digitalRead(TACH_PIN);
  attachInterrupt(digitalPinToInterrupt(TACH_PIN), tachISR, CHANGE);
  sweep();
}

void loop() {
  static int held = 0;
  while (Serial.available()) {
    char c = Serial.read();
    if (c >= '0' && c <= '4') { held = c - '0'; setFan(held); }
    else if (c == 's') { sweep(); held = 0; }
  }
  Serial.printf("  %s  %d RPM\n", NAME[held], measure(1000));
}
