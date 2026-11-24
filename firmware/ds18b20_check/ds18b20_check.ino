// Step 3: DS18B20 only. DQ=GPIO4 with a pull-up (4.7k or 10k) to 3V3. Serial @115200.
// Hold the probe in your fingers: the temperature should rise.
#include <OneWire.h>
#include <DallasTemperature.h>

const uint8_t DS_PIN = 4;
OneWire oneWire(DS_PIN);
DallasTemperature ds(&oneWire);
uint32_t good = 0, bad = 0;

void setup() {
  Serial.begin(115200);
  delay(1000);
}

void loop() {
  // With only the weak internal pull-DOWN, the line reads HIGH only if your pull-up works.
  pinMode(DS_PIN, INPUT_PULLDOWN);
  delay(5);
  bool pullup = digitalRead(DS_PIN);
  pinMode(DS_PIN, INPUT);
  if (!pullup) {
    Serial.println("FAIL: DQ is not pulled up. Check the resistor from DQ to 3V3 (or DQ shorted to GND).");
    delay(2000);
    return;
  }

  ds.begin();
  DeviceAddress addr;
  if (!ds.getAddress(addr, 0)) {
    Serial.println("FAIL: pull-up OK but no sensor answers. Check VDD (3V3), GND, and DQ on GPIO4.");
    delay(2000);
    return;
  }

  ds.setResolution(addr, 12);
  ds.requestTemperaturesByAddress(addr);  // blocks until converted
  float t = ds.getTempC(addr);
  if (t == DEVICE_DISCONNECTED_C) {
    bad++;
    Serial.printf("FAIL: read error (-127). good=%lu bad=%lu\n", (unsigned long)good, (unsigned long)bad);
  } else if (t == 85.0f) {
    bad++;
    Serial.printf("CHECK: 85.0 = sensor reset, usually weak/loose power. good=%lu bad=%lu\n",
                  (unsigned long)good, (unsigned long)bad);
  } else {
    good++;
    Serial.printf("OK  %.2f C   addr=", t);
    for (int i = 0; i < 8; i++) Serial.printf("%02X", addr[i]);
    Serial.printf("   good=%lu bad=%lu\n", (unsigned long)good, (unsigned long)bad);
  }
  delay(1000);
}
