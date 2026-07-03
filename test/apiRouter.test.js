import test from "node:test";
import assert from "node:assert/strict";
import { createApiRequestPacket, createCompactApiRequestPacket } from "../src/core/stream.js";
import { ApiRouter } from "../src/server/apiRouter.js";
import { EventRouter } from "../src/server/eventRouter.js";
import { R2TGGateway } from "../src/server/gateway.js";
import { registerDefaultApiRoutes, registerDefaultEventRoutes } from "../src/server/routes/defaultApiRoutes.js";
import { checkReplay, createSecurityRuntime, createSessionSecurityState } from "../src/server/security.js";

test("gateway handles active default API route over stream protocol", () => {
  const gateway = new R2TGGateway({ now: () => 1000 });
  const response = gateway.handleStreamPacket(createApiRequestPacket({
    requestId: "req-health",
    method: "GET",
    resource: "/health"
  }));

  assert.equal(response.message_type, "api_response");
  assert.equal(response.request_id, "req-health");
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(response.data.ok, true);
  assert.equal(response.data.service, "r2tg");
});

test("gateway handles compact API packets", () => {
  const gateway = new R2TGGateway({ now: () => 1000 });
  const response = gateway.handleStreamPacket(createCompactApiRequestPacket({
    requestId: "req-compact-health",
    method: "GET",
    resource: "/health"
  }));

  assert.equal(response.t, "api_res");
  assert.equal(response.id, "req-compact-health");
  assert.equal(response.o, true);
  assert.equal(response.s, 200);
  assert.equal(response.d.ok, true);
  assert.equal(Object.hasOwn(response, "project"), false);
  assert.equal(Object.hasOwn(response, "timestamp"), false);
});

test("gateway exposes default event topics through event router", () => {
  const gateway = new R2TGGateway({ now: () => 1000 });

  assert.ok(gateway.eventRouter.has("heartbeat"));
  assert.ok(gateway.eventRouter.has("state"));

  const heartbeat = gateway.eventRouter.createEventFrame({
    topic: "heartbeat",
    eventId: "heartbeat-1",
    seq: 1
  });

  assert.equal(heartbeat.t, "evt");
  assert.equal(heartbeat.topic, "heartbeat");
  assert.equal(heartbeat.d.sequence, 1);
  assert.equal(heartbeat.d.timestamp, 1000);
});

test("gateway returns API 404 for unknown resource", () => {
  const gateway = new R2TGGateway({ now: () => 1000 });
  const response = gateway.handleStreamPacket(createApiRequestPacket({
    requestId: "req-missing",
    method: "GET",
    resource: "/missing"
  }));

  assert.equal(response.ok, false);
  assert.equal(response.status, 404);
  assert.equal(response.error.code, "not_found");
});

test("gateway exposes registered API routes from router instance", () => {
  const gateway = new R2TGGateway({ now: () => 1000 });
  const routes = gateway.apiRouter.describeRoutes();

  assert.ok(routes.some((route) => route.method === "GET" && route.path === "/health"));
  assert.ok(!routes.some((route) => route.method === "GET" && route.path === "/test"));
});

test("api router supports custom express-style route params", () => {
  const router = new ApiRouter({
    stateCache: { snapshot: () => ({}) },
    now: () => 1000
  });

  router.get("/thing/:thingId", ({ params, query }) => ({
    status: 200,
    data: {
      thing_id: params.thingId,
      view: query.view
    }
  }));

  const response = router.handle(createApiRequestPacket({
    requestId: "req-thing",
    method: "GET",
    resource: "/thing/alpha?view=detail"
  }));

  assert.equal(response.ok, true);
  assert.equal(response.data.thing_id, "alpha");
  assert.equal(response.data.view, "detail");
});

test("api router returns 405 when path exists with another method", () => {
  const gateway = new R2TGGateway({ now: () => 1000 });
  const response = gateway.handleStreamPacket(createApiRequestPacket({
    requestId: "req-method",
    method: "POST",
    resource: "/health"
  }));

  assert.equal(response.ok, false);
  assert.equal(response.status, 405);
  assert.equal(response.error.code, "method_not_allowed");
  assert.deepEqual(response.data.allowed_methods, ["GET"]);
});

test("default API routes are registered from a separate route module", () => {
  const router = new ApiRouter({
    stateCache: { snapshot: () => ({}) },
    now: () => 1000
  });

  assert.deepEqual(router.describeRoutes(), []);

  registerDefaultApiRoutes(router);

  assert.ok(router.describeRoutes().some((route) => route.path === "/health" && route.method === "GET"));
  assert.ok(!router.describeRoutes().some((route) => route.path === "/test" && route.method === "GET"));
});

test("demo API routes are registered only when explicitly enabled", () => {
  const router = new ApiRouter({
    stateCache: { snapshot: () => ({}) },
    now: () => 1000
  });

  registerDefaultApiRoutes(router, { enableDemoRoutes: true });

  assert.ok(router.describeRoutes().some((route) => route.path === "/test" && route.method === "GET"));
  assert.ok(router.describeRoutes().some((route) => route.path === "/echo" && route.method === "POST"));
});

test("default event topics are registered from the route module", () => {
  const events = new EventRouter({
    stateCache: { snapshot: () => ({}) },
    now: () => 1000
  });

  assert.deepEqual(events.describeTopics(), []);

  registerDefaultEventRoutes(events);

  assert.ok(events.describeTopics().some((route) => route.topic === "heartbeat"));
  assert.ok(events.describeTopics().some((route) => route.topic === "state"));
  assert.ok(!events.describeTopics().some((route) => route.topic === "hello"));
});

test("api router enforces route scope when security context asks for it", () => {
  const router = new ApiRouter({
    stateCache: { snapshot: () => ({}) },
    now: () => 1000
  });
  router.get("/secure", () => ({ data: { ok: true } }), { scope: "admin" });

  const response = router.handle(createApiRequestPacket({
    requestId: "req-secure",
    method: "GET",
    resource: "/secure"
  }), {
    security: { tokenAuth: { enforceScope: true } },
    auth: { claims: { scope: ["api"] } }
  });

  assert.equal(response.ok, false);
  assert.equal(response.status, 403);
  assert.equal(response.error.code, "insufficient_scope");
});

test("api router applies replay protection hook for command routes", () => {
  const runtime = createSecurityRuntime({
    replayProtection: { enabled: true, ttlMs: 300000 },
    rateLimit: { enabled: false },
    frameHmac: { enabled: false },
    tokenAuth: { enforceScope: false },
    messageLimits: {}
  }, () => 1000);
  const authState = createSessionSecurityState({
    authConfig: { enabled: false },
    securityRuntime: runtime
  });
  const router = new ApiRouter({
    stateCache: { snapshot: () => ({}) },
    now: () => 1000
  });
  router.post("/command", () => ({ status: 202, data: { accepted: true } }), {
    replayProtection: true
  });

  const packet = createApiRequestPacket({
    requestId: "req-command",
    method: "POST",
    resource: "/command",
    body: { command_id: "cmd-1" }
  });
  const context = {
    security: runtime.config,
    auth: authState,
    checkReplay: (commandId) => checkReplay(authState, commandId)
  };
  const first = router.handle(packet, context);
  const second = router.handle(createApiRequestPacket({
    requestId: "req-command-duplicate",
    method: "POST",
    resource: "/command",
    body: { command_id: "cmd-1" }
  }), context);

  assert.equal(first.status, 202);
  assert.equal(second.status, 409);
  assert.equal(second.error.code, "duplicate_command_id");
});
