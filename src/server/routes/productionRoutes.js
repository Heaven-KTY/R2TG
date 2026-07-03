import { PROJECT } from "../../core/constants.js";

export function registerProductionApiRoutes(router) {
  router.get("/health", ({ now, startedAt }) => ({
    status: 200,
    data: {
      ok: true,
      service: PROJECT.toLowerCase(),
      uptime_ms: Math.max(0, now() - startedAt)
    }
  }), { name: "health", scope: "api" });

  router.get("/state", ({ stateCache, query }) => ({
    status: 200,
    data: {
      state: stateCache.snapshot(query.device_id ?? null)
    }
  }), { name: "stateSnapshot", scope: "api" });

  return router;
}

export function registerProductionEventRoutes(events) {
  events.topic("heartbeat", ({ seq, timestamp }) => ({
    data: {
      sequence: seq,
      timestamp,
      iso_time: new Date(timestamp).toISOString()
    }
  }), { name: "heartbeat", scope: "events" });

  events.topic("state", ({ stateCache }) => ({
    data: {
      state: stateCache.snapshot()
    }
  }), { name: "stateSnapshot", scope: "events" });

  return events;
}
