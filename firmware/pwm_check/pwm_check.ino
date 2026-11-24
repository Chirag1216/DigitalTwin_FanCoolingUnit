// PWM line diagnostic. Fan on 12 V, grounds joined, TACH on GPIO25. Serial @115200.
// Drives GPIO26 and GPIO27 identically, so you can move the blue wire between
// them without re-uploading. Repeats forever. WATCH THE FAN.
const uint8_t TACH_PIN = 25;
const uint8_t PINS[2] = { 26, 27 };

volatile uint32_t pulses = 0, lastEdgeUs = 0;
volatile bool tachHigh = true;
void IRAM_ATTR tachISR() {
  uint32_t now = micros();
  bool high = digitalRead(TACH_PIN);
  if (high != tachHigh && now - lastEdgeUs >= 1000) {
    tachHigh = high;
    lastEdgeUs = now;
    if (!high) pulses++;
  }
}

bool usable[2];

// Is the pin/wire able to go high at all?
void checkLine(int i) {
  uint8_t p = PINS[i];
  pinMode(p, INPUT_PULLDOWN);
  delay(20);
  bool withPulldown = digitalRead(p);
  pinMode(p, INPUT_PULLUP);
  delay(20);
  bool withPullup = digitalRead(p);
  pinMode(p, OUTPUT);
  digitalWrite(p, HIGH);
  delayMicroseconds(200);
  bool drivenHigh = digitalRead(p);  // only briefly, in case of a short
  digitalWrite(p, LOW);
  usable[i] = withPullup && drivenHigh;

  Serial.printf("GPIO%u: ", p);
  if (!usable[i])
    Serial.println("HELD LOW  <-- shorted to GND (row/wire), or pin damaged. Unplug the wire and compare.");
  else if (withPulldown)
    Serial.println("ok, something pulls it HIGH (normal with a powered fan's PWM wire on it)");
  else
    Serial.println("ok, free (nothing pulling it - normal with no wire on it)");
}

void report(const char *what, uint32_t seconds) {
  Serial.printf("\n>> %s\n", what);
  for (uint32_t s = 0; s < seconds; s++) {
    noInterrupts(); pulses = 0; interrupts();
    delay(1000);
    noInterrupts(); uint32_t c = pulses; interrupts();
    Serial.printf("   %lu RPM\n", (unsigned long)(c * 30));
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  pinMode(TACH_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(TACH_PIN), tachISR, CHANGE);
}

void loop() {
  Serial.println("\n===== PWM check =====");
  for (int i = 0; i < 2; i++) checkLine(i);

  for (int i = 0; i < 2; i++)
    if (usable[i]) digitalWrite(PINS[i], HIGH);
  report("STEADY HIGH (3.3 V) - fan should run FAST", 8);

  for (int i = 0; i < 2; i++) digitalWrite(PINS[i], LOW);
  report("STEADY LOW (0 V) - fan should STOP", 8);

  for (int i = 0; i < 2; i++)
    if (usable[i]) {
      ledcAttach(PINS[i], 25000, 8);
      ledcWrite(PINS[i], 128);
    }
  report("50% PWM at 25 kHz - fan should run MEDIUM (~1700)", 12);
  for (int i = 0; i < 2; i++)
    if (usable[i]) ledcDetach(PINS[i]);
}
