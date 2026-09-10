const assert = require("assert")
const { EventEmitter } = require("events")

class FakeClient extends EventEmitter {
  constructor() {
    super()
    this.connected = true
    this.calls = []
    this.pending = []
    this.ended = false
  }

  publish(topic, payload, options) {
    this.calls.push({ topic, payload, options })

    if (topic.includes("/gate/")) {
      return new Promise((resolve, reject) => {
        this.pending.push({ topic, resolve, reject })
      })
    }

    return Promise.resolve()
  }

  async end() {
    this.ended = true
    this.connected = false
  }
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve))
}

async function main() {
  const asyncMqtt = require("async-mqtt")
  const originalConnectAsync = asyncMqtt.connectAsync
  const fake = new FakeClient()

  asyncMqtt.connectAsync = async () => fake

  delete require.cache[require.resolve("../dist/mqtt")]
  const { createClient } = require("../dist/mqtt")

  const warnings = []
  const log = {
    warning(message) {
      warnings.push(String(message))
    },
    debug() {},
    main() {},
    error() {},
  }

  let client
  try {
    client = await createClient(
      {
        host: "mqtt.example.invalid",
        base_topic: "switch_vision/test",
        retain: true,
        qos: 0,
        clean: true,
      },
      log,
      "0.9.11",
    )
  } finally {
    asyncMqtt.connectAsync = originalConnectAsync
  }

  assert.deepStrictEqual(
    fake.calls.slice(0, 2).map((entry) => entry.topic),
    [
      "switch_vision/test/status",
      "switch_vision/test/config",
    ],
  )

  const first = client.publish("switch_vision/test/gate/1", "one")
  const second = client.publish("switch_vision/test/gate/2", "two")

  await tick()

  assert.strictEqual(
    fake.calls.filter((entry) => entry.topic.includes("/gate/")).length,
    1,
  )

  fake.pending[0].resolve()
  await first
  await tick()

  assert.strictEqual(
    fake.calls.filter((entry) => entry.topic.includes("/gate/")).length,
    2,
  )

  fake.pending[1].reject(new Error("fixture publish failure"))
  await assert.rejects(second, /fixture publish failure/)

  const third = client.publish("switch_vision/test/gate/3", "three")
  await tick()

  assert.strictEqual(
    fake.calls.filter((entry) => entry.topic.includes("/gate/")).length,
    3,
  )

  fake.pending[2].resolve()
  await third

  let closeEvents = 0
  let connectEvents = 0

  client.on("close", () => {
    closeEvents += 1
  })
  client.on("connect", () => {
    connectEvents += 1
  })

  fake.emit("close")
  await tick()
  assert.strictEqual(closeEvents, 1)

  fake.emit("connect")
  await tick()
  await tick()

  assert.strictEqual(connectEvents, 1)
  assert.ok(
    fake.calls.filter(
      (entry) =>
        entry.topic === "switch_vision/test/status" &&
        entry.payload === "online",
    ).length >= 2,
  )

  fake.connected = false
  const skipped = await client.publish(
    "switch_vision/test/skipped",
    "offline",
  )
  assert.strictEqual(skipped, null)
  assert.ok(
    warnings.some((message) =>
      message.includes("MQTT connection closed"),
    ),
  )

  fake.connected = true
  await client.end()

  assert.strictEqual(fake.ended, true)
  assert.ok(
    fake.calls.some(
      (entry) =>
        entry.topic === "switch_vision/test/status" &&
        entry.payload === "offline",
    ),
  )

  console.log(
    "Switch Vision SNMP2MQTT Core v1.0.0 MQTT runtime regression: PASS",
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
