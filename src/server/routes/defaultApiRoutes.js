import { registerDemoApiRoutes, registerDemoEventRoutes } from "./demoRoutes.js";
import { registerProductionApiRoutes, registerProductionEventRoutes } from "./productionRoutes.js";

export function demoRoutesEnabled(env = process.env) {
  return String(env.R2TG_ENABLE_DEMO_ROUTES ?? "0") === "1";
}

export function registerDefaultApiRoutes(router, {
  enableDemoRoutes = demoRoutesEnabled()
} = {}) {
  registerProductionApiRoutes(router);
  if (enableDemoRoutes) {
    registerDemoApiRoutes(router);
  }
  return router;
}

export function registerDefaultEventRoutes(events, {
  enableDemoRoutes = demoRoutesEnabled()
} = {}) {
  registerProductionEventRoutes(events);
  if (enableDemoRoutes) {
    registerDemoEventRoutes(events);
  }
  return events;
}
