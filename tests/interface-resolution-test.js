const assert = require("assert")
const {
  interfaceCandidates,
  interfaceOid,
  interfaceWatchLookup,
  isJuniperEx3300UplinkCandidates,
  observeInterfaceWatch,
  resetInterfaceWatchState,
  resolveInterfaceIndex,
} = require("../dist/interface")

const sensor = {
  name: "SFP 1 RX",
  source: "interface",
  interfaces: ["xe-0/1/0", "ge-0/1/0"],
  attribute: "rx_bytes",
}

assert.deepStrictEqual(interfaceCandidates(sensor), [
  "xe-0/1/0",
  "ge-0/1/0",
])

let table = new Map([
  ["501", "ge-0/0/0"],
  ["601", "xe-0/1/0"],
  ["602", "xe-0/1/0.0"],
])

assert.deepStrictEqual(resolveInterfaceIndex(table, sensor.interfaces), {
  name: "xe-0/1/0",
  ifIndex: 601,
})
assert.strictEqual(
  interfaceOid("rx_bytes", 601),
  "1.3.6.1.2.1.31.1.1.1.6.601",
)

table = new Map([["701", "xe-0/1/0"]])
assert.deepStrictEqual(resolveInterfaceIndex(table, sensor.interfaces), {
  name: "xe-0/1/0",
  ifIndex: 701,
})

table = new Map([["811", "ge-0/1/0"]])
assert.deepStrictEqual(resolveInterfaceIndex(table, sensor.interfaces), {
  name: "ge-0/1/0",
  ifIndex: 811,
})

assert.strictEqual(
  resolveInterfaceIndex(new Map(), ["xe-0/1/1", "ge-0/1/1"]),
  undefined,
)

const watchedCandidates = ["xe-0/1/0", "ge-0/1/0"]
assert.strictEqual(
  isJuniperEx3300UplinkCandidates(watchedCandidates),
  true,
)
assert.strictEqual(
  isJuniperEx3300UplinkCandidates(["ge-0/0/1", "xe-0/0/1"]),
  false,
)
assert.strictEqual(
  isJuniperEx3300UplinkCandidates(["xe-0/1/0"]),
  false,
)

resetInterfaceWatchState()

let observation = observeInterfaceWatch(
  "192.0.2.30",
  watchedCandidates,
  { name: "xe-0/1/0", ifIndex: 601, operStatus: 1 },
  5,
  1000,
)
assert.deepStrictEqual(observation, {
  confirmed: true,
  changed: false,
  pending: false,
  stable: { name: "xe-0/1/0", ifIndex: 601, operStatus: 1 },
})
assert.deepStrictEqual(
  interfaceWatchLookup(
    "192.0.2.30",
    ["ge-0/1/0", "xe-0/1/0"],
    1000,
  ),
  {
    managed: true,
    status: "ready",
    resolved: { name: "xe-0/1/0", ifIndex: 601 },
    operStatus: 1,
  },
)

observation = observeInterfaceWatch(
  "192.0.2.30",
  watchedCandidates,
  { name: "ge-0/1/0", ifIndex: 811, operStatus: 1 },
  5,
  2000,
)
assert.strictEqual(observation.confirmed, false)
assert.strictEqual(observation.pending, true)
assert.deepStrictEqual(
  interfaceWatchLookup("192.0.2.30", watchedCandidates, 2000),
  {
    managed: true,
    status: "pending_identity",
  },
)

observation = observeInterfaceWatch(
  "192.0.2.30",
  watchedCandidates,
  { name: "ge-0/1/0", ifIndex: 811, operStatus: 1 },
  5,
  3000,
)
assert.strictEqual(observation.confirmed, true)
assert.strictEqual(observation.changed, true)
assert.deepStrictEqual(
  interfaceWatchLookup("192.0.2.30", watchedCandidates, 3000),
  {
    managed: true,
    status: "ready",
    resolved: { name: "ge-0/1/0", ifIndex: 811 },
    operStatus: 1,
  },
)

observation = observeInterfaceWatch(
  "192.0.2.30",
  watchedCandidates,
  { name: "ge-0/1/0", ifIndex: 811, operStatus: 2 },
  5,
  4000,
)
assert.strictEqual(observation.confirmed, false)
assert.deepStrictEqual(
  interfaceWatchLookup("192.0.2.30", watchedCandidates, 4000),
  {
    managed: true,
    status: "pending_state",
    resolved: { name: "ge-0/1/0", ifIndex: 811 },
    operStatus: 1,
  },
)

observation = observeInterfaceWatch(
  "192.0.2.30",
  watchedCandidates,
  { name: "ge-0/1/0", ifIndex: 811, operStatus: 2 },
  5,
  5000,
)
assert.strictEqual(observation.confirmed, true)
assert.strictEqual(observation.changed, true)
assert.deepStrictEqual(
  interfaceWatchLookup("192.0.2.30", watchedCandidates, 5000),
  {
    managed: true,
    status: "ready",
    resolved: { name: "ge-0/1/0", ifIndex: 811 },
    operStatus: 2,
  },
)
assert.deepStrictEqual(
  interfaceWatchLookup("192.0.2.30", watchedCandidates, 15001),
  {
    managed: true,
    status: "stale",
  },
)

resetInterfaceWatchState()
observation = observeInterfaceWatch(
  "192.0.2.31",
  watchedCandidates,
  null,
  5,
  1000,
)
assert.strictEqual(observation.confirmed, true)
assert.deepStrictEqual(
  interfaceWatchLookup("192.0.2.31", watchedCandidates, 1000),
  {
    managed: true,
    status: "absent",
  },
)

console.log("Switch Vision SNMP2MQTT live-interface resolution regression: PASS")
