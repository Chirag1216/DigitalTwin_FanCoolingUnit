// I2C bus diagnostic for the fan twin (MPU6050 0x68, INA219 0x40).
// Upload, open Serial Monitor @115200, read the verdicts. Re-runs every 5 s,
// so you can wiggle wires and watch it change.
#include <Wire.h>

const uint8_t SDA_PIN = 21, SCL_PIN = 22;

// Level with the ESP32's internal pull-DOWN on: only reads HIGH if something
// external (the modules' pull-up resistors, i.e. a powered module) pulls it up.
static int levelWithPulldown(uint8_t pin) {
  pinMode(pin, INPUT_PULLDOWN);
  delay(5);
  return digitalRead(pin);
}

// Level with the internal pull-UP on: LOW here means the line is shorted to GND
// (or held low by a stuck/unpowered device).
static int levelWithPullup(uint8_t pin) {
  pinMode(pin, INPUT_PULLUP);
  delay(5);
  return digitalRead(pin);
}

static uint8_t scan(uint8_t sda, uint8_t scl, const char *label) {
  Wire.end();
  Wire.begin(sda, scl);
  Wire.setClock(100000);  // slow & forgiving for long jumper wires
  Serial.printf("  scan %-22s:", label);
  uint8_t found = 0;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.printf(" 0x%02X", a);
      if (a == 0x68 || a == 0x69) Serial.print("(MPU6050)");
      if (a == 0x40) Serial.print("(INA219)");
      found++;
    }
  }
  Serial.println(found ? "" : " none");
  Wire.end();
  return found;
}

void setup() {
  Serial.begin(115200);
  delay(1000);
}

void loop() {
  Serial.println("\n===== I2C check =====");
  int sdaPd = levelWithPulldown(SDA_PIN), sclPd = levelWithPulldown(SCL_PIN);
  int sdaPu = levelWithPullup(SDA_PIN), sclPu = levelWithPullup(SCL_PIN);
  Serial.printf("  GPIO%u SDA: external pull-up %s | with internal pull-up reads %s\n",
                SDA_PIN, sdaPd ? "YES" : "NO ", sdaPu ? "HIGH" : "LOW");
  Serial.printf("  GPIO%u SCL: external pull-up %s | with internal pull-up reads %s\n",
                SCL_PIN, sclPd ? "YES" : "NO ", sclPu ? "HIGH" : "LOW");

  if (!sdaPu || !sclPu)
    Serial.println("  -> A line is stuck LOW: short to GND, or a module wired with no power (VCC) on it.");
  else if (!sdaPd && !sclPd)
    Serial.println("  -> No module pull-ups seen: modules are NOT powered or SDA/SCL wires don't reach the ESP32.\n"
                   "     Check VCC->3V3 and GND on each module (measure ~3.3 V across the module's VCC/GND pins).");
  else if (sdaPd != sclPd)
    Serial.println("  -> Only one line has a pull-up: that other wire is broken/loose or on the wrong pin.");
  else
    Serial.println("  -> Lines look electrically OK (powered modules with pull-ups).");

  uint8_t normal = scan(SDA_PIN, SCL_PIN, "SDA=21 SCL=22");
  uint8_t swapped = scan(SCL_PIN, SDA_PIN, "SDA=22 SCL=21 (swap)");
  if (!normal && swapped)
    Serial.println("  -> Devices answer only when swapped: your SDA and SCL wires are crossed.");
  else if (normal)
    Serial.println("  -> Bus works. If an expected device is missing, check that one module's wiring/solder.");

  delay(5000);
}
