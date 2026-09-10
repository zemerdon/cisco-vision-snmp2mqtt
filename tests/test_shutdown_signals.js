const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const indexPath = path.join(root, "src", "index.ts")
const packagePath = path.join(root, "package.json")

const source = fs.readFileSync(indexPath, "utf8")
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"))

function requireText(needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`Missing ${label}: ${needle}`)
  }
}

if (pkg.version !== "1.0.0") {
  throw new Error(`Expected package version 1.0.0, found ${pkg.version}`)
}

requireText(
  'let exitPromise: Promise<void> | null = null',
  "single-flight shutdown state",
)
requireText(
  "if (exitPromise) {",
  "duplicate shutdown guard",
)
requireText(
  'const handleTerminationSignal = async (signal: "SIGINT" | "SIGTERM") => {',
  "shared termination handler",
)
requireText(
  'process.once("SIGINT"',
  "SIGINT handler",
)
requireText(
  'process.once("SIGTERM"',
  "SIGTERM handler",
)
requireText(
  'void handleTerminationSignal("SIGINT")',
  "SIGINT graceful-shutdown route",
)
requireText(
  'void handleTerminationSignal("SIGTERM")',
  "SIGTERM graceful-shutdown route",
)
requireText(
  'mqtt.off("close", pauseClients)',
  "MQTT close-listener removal",
)
requireText(
  "await mqtt.end()",
  "MQTT graceful close",
)
requireText(
  "await client.end()",
  "SNMP graceful close",
)

const sigintHandlers = (source.match(/process\.once\("SIGINT"/g) || []).length
const sigtermHandlers = (source.match(/process\.once\("SIGTERM"/g) || []).length

if (sigintHandlers !== 1) {
  throw new Error(`Expected one SIGINT handler, found ${sigintHandlers}`)
}
if (sigtermHandlers !== 1) {
  throw new Error(`Expected one SIGTERM handler, found ${sigtermHandlers}`)
}

console.log(
  "Switch Vision SNMP2MQTT Core v1.0.0 shutdown-signal regression: PASS",
)
