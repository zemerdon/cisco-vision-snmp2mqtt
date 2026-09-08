import { InterfaceAttribute, SensorConfig } from "./types"
import { SnmpTable } from "./snmp_table"

export const IF_NAME_OID = "1.3.6.1.2.1.31.1.1.1.1"

export const INTERFACE_ATTRIBUTE_OIDS: Record<InterfaceAttribute, string> = {
  oper_status: "1.3.6.1.2.1.2.2.1.8",
  admin_status: "1.3.6.1.2.1.2.2.1.7",
  speed_mbps: "1.3.6.1.2.1.31.1.1.1.15",
  rx_bytes: "1.3.6.1.2.1.31.1.1.1.6",
  tx_bytes: "1.3.6.1.2.1.31.1.1.1.10",
  alias: "1.3.6.1.2.1.31.1.1.1.18",
}

export const interfaceCandidates = (sensor: SensorConfig): string[] => {
  const raw =
    sensor.interfaces && sensor.interfaces.length
      ? sensor.interfaces
      : sensor.interface
        ? [sensor.interface]
        : []

  const seen = new Set<string>()
  const result: string[] = []

  for (const value of raw) {
    const name = String(value || "").trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }

  return result
}

export const resolveInterfaceIndex = (
  ifNames: SnmpTable,
  candidates: string[],
): { name: string; ifIndex: number } | undefined => {
  const byName = new Map<string, number>()

  for (const [ifIndexRaw, nameRaw] of ifNames) {
    const ifIndex = Number(ifIndexRaw)
    const name = String(nameRaw ?? "").trim()
    if (!Number.isInteger(ifIndex) || ifIndex <= 0 || !name) continue
    if (!byName.has(name)) byName.set(name, ifIndex)
  }

  for (const candidate of candidates) {
    const name = String(candidate || "").trim()
    const ifIndex = byName.get(name)
    if (ifIndex !== undefined) return { name, ifIndex }
  }

  return undefined
}

export const interfaceOid = (
  attribute: InterfaceAttribute,
  ifIndex: number,
): string => `${INTERFACE_ATTRIBUTE_OIDS[attribute]}.${ifIndex}`

export type InterfaceWatchValue = string | number | bigint | boolean

export interface InterfaceWatchSnapshot {
  name: string
  ifIndex: number
  operStatus: InterfaceWatchValue
}

export type InterfaceWatchStatus =
  | "unmanaged"
  | "ready"
  | "pending_identity"
  | "pending_state"
  | "absent"
  | "stale"

export interface InterfaceWatchLookup {
  managed: boolean
  status: InterfaceWatchStatus
  resolved?: {
    name: string
    ifIndex: number
  }
  operStatus?: InterfaceWatchValue
}

interface InterfaceWatchState {
  stable: InterfaceWatchSnapshot | null
  pending?: InterfaceWatchSnapshot | null
  pendingCount: number
  expiresAt: number
}

const interfaceWatchStates = new Map<string, InterfaceWatchState>()

const normalizedWatchCandidates = (candidates: string[]): string[] =>
  Array.from(
    new Set(
      candidates
        .map((candidate) => String(candidate || "").trim())
        .filter(Boolean),
    ),
  ).sort()

const interfaceWatchKey = (host: string, candidates: string[]): string =>
  `${String(host || "").trim()}\u001f${normalizedWatchCandidates(candidates).join(
    "\u001e",
  )}`

const identitySignature = (
  snapshot: InterfaceWatchSnapshot | null,
): string =>
  snapshot === null ? "<absent>" : `${snapshot.name}\u001f${snapshot.ifIndex}`

const snapshotSignature = (
  snapshot: InterfaceWatchSnapshot | null,
): string =>
  snapshot === null
    ? "<absent>"
    : `${identitySignature(snapshot)}\u001f${typeof snapshot.operStatus}:${String(
        snapshot.operStatus,
      )}`

const watchWindowMs = (scanIntervalSeconds: number): number =>
  Math.max(5000, Math.max(1, scanIntervalSeconds) * 2000)

export const isJuniperEx3300UplinkCandidates = (
  candidates: string[],
): boolean => {
  const names = normalizedWatchCandidates(candidates)
  return (
    names.length === 2 &&
    names.every((name) => /^(?:ge|xe)-0\/1\/[0-3]$/.test(name)) &&
    names.some((name) => name.startsWith("ge-")) &&
    names.some((name) => name.startsWith("xe-"))
  )
}

export const observeInterfaceWatch = (
  host: string,
  candidates: string[],
  observation: InterfaceWatchSnapshot | null,
  scanIntervalSeconds: number,
  nowMs: number = Date.now(),
): {
  confirmed: boolean
  changed: boolean
  pending: boolean
  stable: InterfaceWatchSnapshot | null
} => {
  const key = interfaceWatchKey(host, candidates)
  const ttl = watchWindowMs(scanIntervalSeconds)
  const existing = interfaceWatchStates.get(key)

  if (!existing) {
    interfaceWatchStates.set(key, {
      stable: observation,
      pendingCount: 0,
      expiresAt: nowMs + ttl,
    })
    return {
      confirmed: true,
      changed: false,
      pending: false,
      stable: observation,
    }
  }

  if (snapshotSignature(observation) === snapshotSignature(existing.stable)) {
    existing.pending = undefined
    existing.pendingCount = 0
    existing.expiresAt = nowMs + ttl
    return {
      confirmed: true,
      changed: false,
      pending: false,
      stable: existing.stable,
    }
  }

  if (
    existing.pending === undefined ||
    snapshotSignature(existing.pending) !== snapshotSignature(observation)
  ) {
    existing.pending = observation
    existing.pendingCount = 1
  } else {
    existing.pendingCount += 1
  }

  if (identitySignature(observation) === identitySignature(existing.stable)) {
    // The physical interface identity is freshly confirmed even while a link
    // state delta is being debounced, so traffic may safely keep using it.
    existing.expiresAt = nowMs + ttl
  }

  if (existing.pendingCount < 2) {
    return {
      confirmed: false,
      changed: false,
      pending: true,
      stable: existing.stable,
    }
  }

  existing.stable = observation
  existing.pending = undefined
  existing.pendingCount = 0
  existing.expiresAt = nowMs + ttl
  return {
    confirmed: true,
    changed: true,
    pending: false,
    stable: observation,
  }
}

export const interfaceWatchLookup = (
  host: string,
  candidates: string[],
  nowMs: number = Date.now(),
): InterfaceWatchLookup => {
  const state = interfaceWatchStates.get(interfaceWatchKey(host, candidates))
  if (!state) {
    return { managed: false, status: "unmanaged" }
  }

  if (state.pending !== undefined) {
    if (identitySignature(state.pending) !== identitySignature(state.stable)) {
      return { managed: true, status: "pending_identity" }
    }
    if (state.stable !== null && nowMs <= state.expiresAt) {
      return {
        managed: true,
        status: "pending_state",
        resolved: {
          name: state.stable.name,
          ifIndex: state.stable.ifIndex,
        },
        operStatus: state.stable.operStatus,
      }
    }
  }

  if (nowMs > state.expiresAt) {
    return { managed: true, status: "stale" }
  }

  if (state.stable === null) {
    return { managed: true, status: "absent" }
  }

  return {
    managed: true,
    status: "ready",
    resolved: {
      name: state.stable.name,
      ifIndex: state.stable.ifIndex,
    },
    operStatus: state.stable.operStatus,
  }
}

export const resetInterfaceWatchState = (): void => {
  interfaceWatchStates.clear()
}
