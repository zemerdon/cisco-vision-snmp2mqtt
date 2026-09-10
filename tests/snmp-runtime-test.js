const assert = require("assert")
const snmp = require("net-snmp")
const {
  IF_NAME_OID,
  observeInterfaceWatch,
  resetInterfaceWatchState,
} = require("../dist/interface")
const { Target } = require("../dist/snmp")
const {
  JUNIPER_VLAN_OIDS,
} = require("../dist/vendors/juniper/vlan")

const warnings = []

const log = {
  warning(message) {
    warnings.push(String(message))
  },
  debug() {},
  main() {},
  error() {},
}

async function testCounter64() {
  const target = new Target(
    {
      host: "192.0.2.10",
      version: "2c",
      community: "readonly",
      sensors: [
        {
          name: "Counter",
          oid: "1.3.6.1.2.1.31.1.1.1.6.1",
        },
      ],
    },
    log,
  )

  const expected = 0x0102030405060708n
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(expected)

  const decoded = target.decodeVarbind(
    {
      type: snmp.ObjectType.Counter64,
      value: buffer,
    },
    {
      name: "Counter",
      oid: "1.3.6.1.2.1.31.1.1.1.6.1",
    },
  )

  assert.strictEqual(decoded, expected)
}

async function testOverlappingPollSuppression() {
  warnings.length = 0

  const target = new Target(
    {
      host: "192.0.2.20",
      version: "2c",
      community: "readonly",
      scan_interval: 10,
      sensors: [
        {
          name: "Port status",
          oid: "1.3.6.1.2.1.2.2.1.8.1",
        },
      ],
    },
    log,
  )

  let getCalls = 0
  let release

  target.getOids = () => {
    getCalls += 1
    return new Promise((resolve) => {
      release = () =>
        resolve([
          {
            type: snmp.ObjectType.Integer,
            value: 1,
          },
        ])
    })
  }

  let responses = 0
  target.on("response", () => {
    responses += 1
  })

  const first = target.fetch()
  await Promise.resolve()

  const second = target.fetch()
  await second

  assert.strictEqual(getCalls, 1)
  assert.strictEqual(responses, 0)
  assert.ok(
    warnings.some((message) =>
      message.includes("Skipping overlapping poll"),
    ),
  )

  release()
  await first

  assert.strictEqual(responses, 1)

  target.getOids = async () => [
    {
      type: snmp.ObjectType.Integer,
      value: 2,
    },
  ]

  await target.fetch()
  assert.strictEqual(responses, 2)
}

const ex3300Candidates = ["xe-0/1/0", "ge-0/1/0"]

function installSubtreeSession(target, tables, calls = []) {
  target.session = {
    subtree(oid, _maxRepetitions, feed, done) {
      calls.push(oid)
      const rows = tables[oid] || []
      if (rows.length) {
        feed(
          rows.map(([index, value]) => ({
            oid: `${oid}.${index}`,
            value,
          })),
        )
      }
      done(null)
    },
  }
  return calls
}

async function fetchResponse(target) {
  let response
  target.on("response", (values) => {
    response = values
  })
  await target.fetch()
  assert.ok(response)
  return response
}

async function testEx3300WatcherDebounce() {
  resetInterfaceWatchState()

  const target = new Target(
    {
      host: "192.0.2.30",
      device_model: "Juniper EX3300-48P",
      scan_interval: 5,
      sensors: [
        {
          name: "SFP 1 Status",
          source: "interface",
          interfaces: ex3300Candidates,
          attribute: "oper_status",
        },
      ],
    },
    log,
  )

  let currentName = "xe-0/1/0"
  let currentIndex = 601
  let currentStatus = 1

  target.session = {
    subtree(oid, _maxRepetitions, feed, done) {
      feed([
        {
          oid: `${oid}.${currentIndex}`,
          value: currentName,
        },
      ])
      done(null)
    },
  }
  target.getOids = async () => [
    {
      type: snmp.ObjectType.Integer,
      value: currentStatus,
    },
  ]

  let values = await fetchResponse(target)
  assert.strictEqual(values[0], 1)

  currentName = "ge-0/1/0"
  currentIndex = 811
  currentStatus = 2

  values = await fetchResponse(target)
  assert.strictEqual(values[0].name, "SensorUnavailableError")
  assert.match(values[0].message, /pending_identity/)

  values = await fetchResponse(target)
  assert.strictEqual(values[0], 2)

  currentStatus = 1

  values = await fetchResponse(target)
  assert.strictEqual(values[0], 2)

  values = await fetchResponse(target)
  assert.strictEqual(values[0], 1)
}

async function testEx3300PendingAndStaleSuppression() {
  resetInterfaceWatchState()

  const now = Date.now()
  observeInterfaceWatch(
    "192.0.2.40",
    ex3300Candidates,
    { name: "xe-0/1/0", ifIndex: 601, operStatus: 1 },
    5,
    now,
  )
  observeInterfaceWatch(
    "192.0.2.40",
    ex3300Candidates,
    { name: "ge-0/1/0", ifIndex: 811, operStatus: 1 },
    5,
    now + 1,
  )

  const pendingTarget = new Target(
    {
      host: "192.0.2.40",
      device_model: "Juniper EX3300-48P",
      scan_interval: 30,
      sensors: [
        {
          name: "SFP 1 RX",
          source: "interface",
          interfaces: ex3300Candidates,
          attribute: "rx_bytes",
        },
        {
          name: "SFP 1 Native VLAN",
          source: "juniper_ex_vlan",
          interfaces: ex3300Candidates,
          attribute: "native_vlan",
        },
      ],
    },
    log,
  )

  const pendingCalls = installSubtreeSession(
    pendingTarget,
    {
      [IF_NAME_OID]: [["811", "ge-0/1/0"]],
    },
  )
  let pendingGets = 0
  pendingTarget.getOids = async () => {
    pendingGets += 1
    return []
  }

  let values = await fetchResponse(pendingTarget)
  assert.strictEqual(values[0].name, "SensorUnavailableError")
  assert.strictEqual(values[1].name, "SensorUnavailableError")
  assert.match(values[0].message, /pending_identity/)
  assert.match(values[1].message, /pending_identity/)
  assert.strictEqual(pendingGets, 0)
  assert.deepStrictEqual(pendingCalls, [IF_NAME_OID])

  resetInterfaceWatchState()
  observeInterfaceWatch(
    "192.0.2.41",
    ex3300Candidates,
    { name: "xe-0/1/0", ifIndex: 601, operStatus: 1 },
    5,
    0,
  )

  const staleTarget = new Target(
    {
      host: "192.0.2.41",
      device_model: "Juniper EX3300-48P",
      scan_interval: 30,
      sensors: [
        {
          name: "SFP 1 RX",
          source: "interface",
          interfaces: ex3300Candidates,
          attribute: "rx_bytes",
        },
        {
          name: "SFP 1 Native VLAN",
          source: "juniper_ex_vlan",
          interfaces: ex3300Candidates,
          attribute: "native_vlan",
        },
      ],
    },
    log,
  )

  const staleCalls = installSubtreeSession(
    staleTarget,
    {
      [IF_NAME_OID]: [["601", "xe-0/1/0"]],
    },
  )
  let staleGets = 0
  staleTarget.getOids = async () => {
    staleGets += 1
    return []
  }

  values = await fetchResponse(staleTarget)
  assert.strictEqual(values[0].name, "SensorUnavailableError")
  assert.strictEqual(values[1].name, "SensorUnavailableError")
  assert.match(values[0].message, /stale/)
  assert.match(values[1].message, /stale/)
  assert.strictEqual(staleGets, 0)
  assert.deepStrictEqual(staleCalls, [IF_NAME_OID])
}

async function testEx3300ResumeAfterConfirmation() {
  resetInterfaceWatchState()

  const now = Date.now()
  observeInterfaceWatch(
    "192.0.2.50",
    ex3300Candidates,
    { name: "xe-0/1/0", ifIndex: 601, operStatus: 1 },
    5,
    now,
  )
  observeInterfaceWatch(
    "192.0.2.50",
    ex3300Candidates,
    { name: "ge-0/1/0", ifIndex: 811, operStatus: 1 },
    5,
    now + 1,
  )
  observeInterfaceWatch(
    "192.0.2.50",
    ex3300Candidates,
    { name: "ge-0/1/0", ifIndex: 811, operStatus: 1 },
    5,
    now + 2,
  )

  const target = new Target(
    {
      host: "192.0.2.50",
      device_model: "Juniper EX3300-48P",
      scan_interval: 30,
      sensors: [
        {
          name: "SFP 1 RX",
          source: "interface",
          interfaces: ex3300Candidates,
          attribute: "rx_bytes",
        },
        {
          name: "SFP 1 Native VLAN",
          source: "juniper_ex_vlan",
          interfaces: ex3300Candidates,
          attribute: "native_vlan",
        },
      ],
    },
    log,
  )

  const tables = {
    [IF_NAME_OID]: [["811", "ge-0/1/0"]],
    [JUNIPER_VLAN_OIDS.dot1dBasePortIfIndex]: [["5", 811]],
    [JUNIPER_VLAN_OIDS.dot1qPvid]: [["5", 10]],
    [JUNIPER_VLAN_OIDS.jnxExVlanName]: [["100", "users"]],
    [JUNIPER_VLAN_OIDS.jnxExVlanTag]: [["100", 10]],
    [JUNIPER_VLAN_OIDS.jnxExVlanPortTagness]: [["100.5", 2]],
    [JUNIPER_VLAN_OIDS.jnxExVlanPortAccessMode]: [["100.5", 1]],
  }
  const calls = installSubtreeSession(target, tables)

  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(123n)
  target.getOids = async (oids) => {
    assert.deepStrictEqual(oids, [
      "1.3.6.1.2.1.31.1.1.1.6.811",
    ])
    return [
      {
        type: snmp.ObjectType.Counter64,
        value: counter,
      },
    ]
  }

  const values = await fetchResponse(target)
  assert.strictEqual(values[0], 123n)
  assert.strictEqual(values[1], 10)
  assert.strictEqual(calls[0], IF_NAME_OID)
  assert.ok(calls.includes(JUNIPER_VLAN_OIDS.dot1dBasePortIfIndex))
  assert.ok(calls.includes(JUNIPER_VLAN_OIDS.dot1qPvid))
}

async function testNonEx3300Compatibility() {
  resetInterfaceWatchState()

  const target = new Target(
    {
      host: "192.0.2.60",
      device_model: "Juniper EX4200-48P",
      scan_interval: 10,
      sensors: [
        {
          name: "Compatible interface",
          source: "interface",
          interfaces: ex3300Candidates,
          attribute: "oper_status",
        },
      ],
    },
    log,
  )

  installSubtreeSession(target, {
    [IF_NAME_OID]: [["901", "xe-0/1/0"]],
  })
  target.getOids = async (oids) => {
    assert.deepStrictEqual(oids, [
      "1.3.6.1.2.1.2.2.1.8.901",
    ])
    return [
      {
        type: snmp.ObjectType.Integer,
        value: 2,
      },
    ]
  }

  const values = await fetchResponse(target)
  assert.strictEqual(values[0], 2)
}

async function main() {
  await testCounter64()
  await testOverlappingPollSuppression()
  await testEx3300WatcherDebounce()
  await testEx3300PendingAndStaleSuppression()
  await testEx3300ResumeAfterConfirmation()
  await testNonEx3300Compatibility()
  console.log(
    "Switch Vision SNMP2MQTT Core v1.0.0 SNMP runtime regression: PASS",
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
