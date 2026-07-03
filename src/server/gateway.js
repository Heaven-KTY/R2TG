import { FecCollector } from "../core/fec/collector.js";
import { packetFromBytes, packetToBytes } from "../core/encoding.js";
import { StateCache } from "../core/stateCache.js";
import { createAckPacket } from "../core/stream.js";
import { ApiRouter } from "./apiRouter.js";
import { EventRouter } from "./eventRouter.js";
import { registerDefaultApiRoutes, registerDefaultEventRoutes } from "./routes/defaultApiRoutes.js";
import { verifyFrameHmac } from "./security.js";

const DEFAULT_FEC_FLUSH_INTERVAL_MS = 1000;
const MIN_FEC_FLUSH_INTERVAL_MS = 100;

function normalizeFecFlushIntervalMs(value, fecTimeoutMs) {
  const fallback = Number.isFinite(fecTimeoutMs) && fecTimeoutMs > 0
    ? Math.min(fecTimeoutMs, DEFAULT_FEC_FLUSH_INTERVAL_MS)
    : DEFAULT_FEC_FLUSH_INTERVAL_MS;
  const interval = Number.isFinite(value) && value > 0 ? value : fallback;

  return Math.max(MIN_FEC_FLUSH_INTERVAL_MS, Math.floor(interval));
}

export class R2TGGateway {
  constructor({
    fecTimeoutMs = 50,
    fecFlushIntervalMs,
    stateTtlMs = 1000,
    maxPacketAgeMs = 1000,
    enableDemoRoutes = process.env.R2TG_ENABLE_DEMO_ROUTES === "1",
    now = () => Date.now()
  } = {}) {
    this.now = now;
    this.fecCollector = new FecCollector({ timeoutMs: fecTimeoutMs, now });
    this.fecFlushIntervalMs = normalizeFecFlushIntervalMs(fecFlushIntervalMs, this.fecCollector.timeoutMs);
    this.maintenanceTimer = null;
    this.stateCache = new StateCache({ ttlMs: stateTtlMs, maxPacketAgeMs, now });
    this.apiRouter = new ApiRouter({ stateCache: this.stateCache, now });
    this.eventRouter = new EventRouter({ stateCache: this.stateCache, now });
    registerDefaultApiRoutes(this.apiRouter, { enableDemoRoutes });
    registerDefaultEventRoutes(this.eventRouter, { enableDemoRoutes });
  }

  flushExpiredFecGroups() {
    const timestamp = this.now();
    const expired = this.fecCollector.flushExpired(timestamp);

    if (expired.length > 0) {
      console.debug("[R2TG] expired FEC groups flushed", {
        count: expired.length,
        timestamp
      });
    }

    return expired;
  }

  startMaintenance() {
    if (this.maintenanceTimer) {
      return this;
    }

    this.maintenanceTimer = setInterval(() => {
      this.flushExpiredFecGroups();
    }, this.fecFlushIntervalMs);
    this.maintenanceTimer.unref?.();

    return this;
  }

  stopMaintenance() {
    if (!this.maintenanceTimer) {
      return this;
    }

    clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;

    return this;
  }

  handleDatagramBytes(bytes, context = {}) {
    const packet = packetFromBytes(bytes);
    const hmac = verifyFrameHmac(context.security ?? { frameHmac: { enabled: false } }, packet);
    if (!hmac.ok) {
      return { status: "dropped", reason: hmac.error.code, packets: [], cacheUpdates: [] };
    }

    const fecResult = this.fecCollector.receive(packet);

    if (fecResult.status !== "ready" && fecResult.status !== "recovered") {
      return { ...fecResult, cacheUpdates: [] };
    }

    const cacheUpdates = fecResult.packets.map((readyPacket) => ({
      packet: readyPacket,
      result: this.stateCache.upsert(readyPacket)
    }));

    return { ...fecResult, cacheUpdates };
  }

  handleStreamPacket(packet, context = {}) {
    const apiResponse = this.apiRouter.handle(packet, context);
    if (apiResponse) {
      return apiResponse;
    }

    if (packet.message_type !== "command") {
      return null;
    }

    return createAckPacket({
      commandId: packet.command_id,
      deviceId: packet.device_id,
      ok: true,
      timestamp: this.now()
    });
  }

  snapshotBytes(deviceId = null) {
    return packetToBytes({
      version: 1,
      project: "R2TG",
      message_type: "state_snapshot",
      source: "state_cache",
      stale: false,
      timestamp: this.now(),
      state: this.stateCache.snapshot(deviceId)
    });
  }
}
