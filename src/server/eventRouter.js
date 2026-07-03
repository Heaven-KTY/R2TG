function normalizeTopic(value) {
  const topic = String(value ?? "").trim().replace(/^\/+|\/+$/g, "");
  return topic || "heartbeat";
}

function toEventResult(result) {
  if (result === undefined) {
    return { event: "message", data: null };
  }
  if (result === null) {
    return { event: "message", data: null };
  }
  if (typeof result === "object" && (Object.hasOwn(result, "event") || Object.hasOwn(result, "data"))) {
    return {
      event: result.event ?? "message",
      data: Object.hasOwn(result, "data") ? result.data : null
    };
  }
  return { event: "message", data: result };
}

export class EventRouter {
  constructor({
    stateCache,
    now = () => Date.now()
  } = {}) {
    this.stateCache = stateCache;
    this.now = now;
    this.routes = new Map();
  }

  topic(topic, handler, options = {}) {
    if (!topic) {
      throw new Error("topic is required");
    }
    if (typeof handler !== "function") {
      throw new Error("handler must be a function");
    }

    const normalizedTopic = normalizeTopic(topic);
    this.routes.set(normalizedTopic, {
      topic: normalizedTopic,
      name: options.name ?? normalizedTopic,
      scope: options.scope ?? null,
      handler
    });
    return this;
  }

  has(topic) {
    return this.routes.has(normalizeTopic(topic));
  }

  describeTopics() {
    return [...this.routes.values()].map(({ topic, name, scope }) => ({ topic, name, scope }));
  }

  get(topic) {
    return this.routes.get(normalizeTopic(topic)) ?? null;
  }

  createEventFrame({ topic, eventId, seq }) {
    const normalizedTopic = normalizeTopic(topic);
    const route = this.routes.get(normalizedTopic);
    if (!route) {
      return null;
    }

    const timestamp = this.now();
    let result;
    try {
      result = toEventResult(route.handler({
        topic: normalizedTopic,
        eventId,
        seq,
        timestamp,
        stateCache: this.stateCache,
        now: this.now,
        router: this
      }));
    } catch (error) {
      result = {
        event: "error",
        data: {
          code: "event_handler_failed",
          message: error.message
        }
      };
    }

    return {
      t: "evt",
      topic: normalizedTopic,
      event: result.event,
      id: eventId,
      ts: timestamp,
      d: result.data
    };
  }
}
