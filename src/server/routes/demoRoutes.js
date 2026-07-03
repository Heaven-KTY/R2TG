export function registerDemoApiRoutes(router) {
  router.get("/test", ({ query }) => ({
    status: 200,
    data: {
      hello: "hello world",
      query
    }
  }), { name: "demoTest", scope: "api" });

  router.post("/echo", ({ request, body }) => ({
    status: 200,
    data: {
      params: request.params ?? {},
      body
    }
  }), { name: "demoEcho", scope: "api" });

  router.post("/command", ({ request, body }) => ({
    status: 202,
    data: {
      accepted: true,
      command_id: body?.command_id ?? body?.commandId ?? null,
      command: body?.command ?? request.params?.command ?? null,
      params: body?.params ?? request.params ?? {}
    }
  }), {
    name: "demoCommand",
    scope: "control",
    rateLimitKey: "command",
    replayProtection: true
  });

  return router;
}

export function registerDemoEventRoutes(events) {
  events.topic("hello", () => ({
    data: {
      hello: "hello world"
    }
  }), { name: "demoHello", scope: "events" });

  return events;
}
