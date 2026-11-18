#include "mqtt_link.h"
#include "config.h"
#include "secrets.h"
#include "fan_control.h"
#include <WiFi.h>
#include <PubSubClient.h>
#include <atomic>
#include <math.h>

static const char *T_TELEMETRY = TOPIC_BASE "/telemetry";
static const char *T_STATUS = TOPIC_BASE "/status";
static const char *T_CMD = TOPIC_BASE "/cmd";
static const char *T_EVENT = TOPIC_BASE "/event";
static const char *LWT_MSG = "{\"online\":false}";

static WiFiClient net;
static PubSubClient mqtt(net);
static QueueHandle_t rowQueue = nullptr;
static std::atomic<bool> statusDirty{ true };
static std::atomic<bool> connected{ false };
static std::atomic<int> pendingPreset{ -1 };
static char clientId[32];

// ---------- helpers (run on the MQTT task only) ----------
static void publishEvent(const char *msg) {
  char buf[128];
  snprintf(buf, sizeof(buf), "{\"msg\":\"%s\"}", msg);
  mqtt.publish(T_EVENT, buf);
}

static void publishStatus() {
  uint8_t p = presetIdx;  // single-byte read, atomic
  char buf[128];
  snprintf(buf, sizeof(buf), "{\"online\":true,\"preset\":%u,\"name\":\"%s\",\"duty\":%u}",
           p, PRESETS[p].name, PRESETS[p].duty);
  mqtt.publish(T_STATUS, buf, true);
}

// JSON can't carry NaN - emit null instead
static int fmtF(char *dst, size_t n, const char *key, float v, int prec) {
  if (isnan(v) || isinf(v)) return snprintf(dst, n, "\"%s\":null,", key);
  return snprintf(dst, n, "\"%s\":%.*f,", key, prec, v);
}

static void publishRow(const Row &r) {
  static const char *meanK[6] = { "ax_mean", "ay_mean", "az_mean", "gx_mean", "gy_mean", "gz_mean" };
  static const char *stdK[6] = { "ax_std", "ay_std", "az_std", "gx_std", "gy_std", "gz_std" };
  static const char *p2pK[3] = { "ax_p2p", "ay_p2p", "az_p2p" };
  char buf[1024];
  size_t len = 0;
#define ADD(...) len += snprintf(buf + len, sizeof(buf) - len, __VA_ARGS__)
#define ADDF(k, v, p) len += fmtF(buf + len, sizeof(buf) - len, k, v, p)
  ADD("{\"t_ms\":%lu,\"n\":%lu,", r.t_ms, r.n);
  for (int i = 0; i < 6; i++) ADDF(meanK[i], r.mean[i], i < 3 ? 3 : 4);
  for (int i = 0; i < 6; i++) ADDF(stdK[i], r.stdv[i], 4);
  for (int i = 0; i < 3; i++) ADDF(p2pK[i], r.p2p[i], 4);
  ADDF("temp_C", r.tempC, 2);
  ADDF("shunt_mV", r.shunt_mV, 3);
  ADDF("bus_V", r.bus_V, 3);
  ADDF("load_V", r.load_V, 3);
  ADDF("current_mA", r.current_mA, 2);
  ADD("\"ina_age_ms\":%lu,\"ina_fresh\":%d,", r.inaAge_ms, r.inaFresh ? 1 : 0);
  ADDF("ds_temp_C", r.dsTempC, 2);
  ADD("\"ds_age_ms\":%lu,\"preset\":%u,\"duty_pct\":%u,", r.dsAge_ms, r.preset, r.duty);
  ADDF("rpm", r.rpm, 0);
  ADD("\"settled\":%d}", r.settled ? 1 : 0);
#undef ADD
#undef ADDF
  if (len < sizeof(buf)) mqtt.publish(T_TELEMETRY, buf);
}

static void onMessage(char *topic, byte *payload, unsigned int len) {
  if (strcmp(topic, T_CMD) != 0) return;
  char s[64];
  len = min(len, (unsigned int)sizeof(s) - 1);
  memcpy(s, payload, len);
  s[len] = 0;

  // accept {"preset":N} or bare N
  const char *p = s;
  if (const char *k = strstr(s, "preset")) {
    const char *colon = strchr(k, ':');
    p = colon ? colon + 1 : "";
  }
  while (*p == ' ' || *p == '"') p++;
  char *end;
  long v = strtol(p, &end, 10);
  if (end == p || v < 0 || v >= NUM_PRESETS) {
    publishEvent("rejected cmd: preset must be 0..4");
    return;
  }
  pendingPreset = (int)v;  // applied on core 1 by loop()
}

static bool tryConnect() {
  const char *user = strlen(MQTT_USER) ? MQTT_USER : nullptr;
  const char *pass = strlen(MQTT_USER) ? MQTT_PASS : nullptr;
  if (!mqtt.connect(clientId, user, pass, T_STATUS, 1, true, LWT_MSG)) return false;
  mqtt.subscribe(T_CMD, 1);
  publishStatus();
  statusDirty = false;
  publishEvent("connected");
  return true;
}

static void mqttTask(void *) {
  uint32_t lastTry = 0;
  bool first = true;
  Row r;
  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      connected = false;
      vTaskDelay(pdMS_TO_TICKS(200));
      continue;
    }
    if (!mqtt.connected()) {
      connected = false;
      uint32_t now = millis();
      if (first || now - lastTry >= MQTT_RETRY_MS) {
        first = false;
        lastTry = now;
        connected = tryConnect();
      }
      // drain stale rows while offline
      while (xQueueReceive(rowQueue, &r, 0) == pdTRUE) {}
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }
    connected = true;
    mqtt.loop();
    if (statusDirty.exchange(false)) publishStatus();
    if (xQueueReceive(rowQueue, &r, pdMS_TO_TICKS(10)) == pdTRUE) publishRow(r);
  }
}

// ---------- public API ----------
void mqttInit() {
  // Factory MAC from eFuse (WiFi.macAddress() returns zeros before WiFi starts)
  uint64_t efuse = ESP.getEfuseMac();
  const uint8_t *mac = (const uint8_t *)&efuse;
  WiFi.mode(WIFI_STA);
  snprintf(clientId, sizeof(clientId), "fantwin-%s-%02x%02x", DEVICE_ID, mac[4], mac[5]);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(1024);
  mqtt.setKeepAlive(MQTT_KEEPALIVE_S);
  mqtt.setSocketTimeout(2);
  mqtt.setCallback(onMessage);

  rowQueue = xQueueCreate(4, sizeof(Row));
  xTaskCreatePinnedToCore(mqttTask, "mqtt", 8192, nullptr, 1, nullptr, 0);
}

void mqttPublishRow(const Row &r) {
  if (rowQueue && connected) xQueueSend(rowQueue, &r, 0);
}

void mqttNotifyStatus() {
  statusDirty = true;
}

int mqttTakeCommand() {
  return pendingPreset.exchange(-1);
}

bool mqttConnected() {
  return connected;
}
