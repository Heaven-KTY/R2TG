import {
  createApiResponsePacket,
  createCompactApiResponsePacket,
  isApiRequestPacket,
  normalizeApiRequestPacket
} from "../core/stream.js";
import { hasRequiredScope } from "./security.js";

const ROUTE_PARAM_PATTERN = /^:([A-Za-z_][A-Za-z0-9_]*)$/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePath(value) {
  const normalized = `/${String(value ?? "").replace(/^\/+|\/+$/g, "")}`;
  return normalized === "/" ? "/" : normalized;
}

function parseRequestTarget(resource) {
  const url = new URL(resource || "/", "https://r2tg.local");
  return {
    path: normalizePath(url.pathname),
    query: Object.fromEntries(url.searchParams.entries())
  };
}

function compilePath(pattern) {
  const normalized = normalizePath(pattern);
  const paramNames = [];

  if (normalized === "/") {
    return {
      pattern: normalized,
      match(path) {
        return path === "/" ? {} : null;
      }
    };
  }

  const parts = normalized.slice(1).split("/").map((part) => {
    const paramMatch = part.match(ROUTE_PARAM_PATTERN);
    if (paramMatch) {
      paramNames.push(paramMatch[1]);
      return "([^/]+)";
    }
    return escapeRegExp(part);
  });

  const regex = new RegExp(`^/${parts.join("/")}$`);

  return {
    pattern: normalized,
    match(path) {
      const match = path.match(regex);
      if (!match) {
        return null;
      }

      return paramNames.reduce((params, name, index) => {
        params[name] = decodeURIComponent(match[index + 1]);
        return params;
      }, {});
    }
  };
}

function toResult(result) {
  if (result === undefined) {
    return { status: 204, data: null };
  }
  if (result === null) {
    return { status: 200, data: null };
  }
  if (
    typeof result === "object" &&
    (
      Object.hasOwn(result, "status") ||
      Object.hasOwn(result, "ok") ||
      Object.hasOwn(result, "data") ||
      Object.hasOwn(result, "error")
    )
  ) {
    return result;
  }
  return { status: 200, data: result };
}

function createResponse({ request, result, now }) {
  const normalized = toResult(result);
  const status = normalized.status ?? (normalized.error ? 500 : 200);
  const ok = normalized.ok ?? (status >= 200 && status < 400);

  if (request.compact) {
    return createCompactApiResponsePacket({
      requestId: request.request_id,
      ok,
      status,
      data: normalized.data ?? null,
      error: normalized.error ?? null
    });
  }

  return createApiResponsePacket({
    requestId: request.request_id,
    ok,
    status,
    data: normalized.data ?? null,
    error: normalized.error ?? null,
    timestamp: now()
  });
}

function createError({ request, status, code, message, now, data = null }) {
  const requestId = request.request_id || "missing-request-id";

  if (request.compact) {
    return createCompactApiResponsePacket({
      requestId,
      ok: false,
      status,
      data,
      error: { code, message }
    });
  }

  return createApiResponsePacket({
    requestId,
    ok: false,
    status,
    data,
    error: { code, message },
    timestamp: now()
  });
}

function extractCommandId(request) {
  const body = request.body && typeof request.body === "object" ? request.body : {};
  const params = request.params && typeof request.params === "object" ? request.params : {};
  return body.command_id ?? body.commandId ?? params.command_id ?? params.commandId ?? null;
}

export class ApiRouter {
  constructor({
    stateCache,
    now = () => Date.now(),
    startedAt = now()
  }) {
    this.stateCache = stateCache;
    this.now = now;
    this.startedAt = startedAt;
    this.routes = [];
  }

  route(method, path, handler, options = {}) {
    if (!method) {
      throw new Error("method is required");
    }
    if (!path) {
      throw new Error("path is required");
    }
    if (typeof handler !== "function") {
      throw new Error("handler must be a function");
    }

    const compiled = compilePath(path);
    const route = {
      method: method.toUpperCase(),
      path: compiled.pattern,
      name: options.name ?? `${method.toUpperCase()} ${compiled.pattern}`,
      scope: options.scope ?? null,
      rateLimitKey: options.rateLimitKey ?? null,
      replayProtection: options.replayProtection === true,
      handler,
      match: compiled.match
    };
    this.routes.push(route);
    return this;
  }

  get(path, handler, options = {}) {
    return this.route("GET", path, handler, options);
  }

  post(path, handler, options = {}) {
    return this.route("POST", path, handler, options);
  }

  put(path, handler, options = {}) {
    return this.route("PUT", path, handler, options);
  }

  delete(path, handler, options = {}) {
    return this.route("DELETE", path, handler, options);
  }

  describeRoutes() {
    return this.routes.map(({ method, path, name, scope, replayProtection }) => ({
      method,
      path,
      name,
      scope,
      replayProtection
    }));
  }

  find(method, path) {
    const pathMatches = [];

    for (const route of this.routes) {
      const params = route.match(path);
      if (!params) {
        continue;
      }
      pathMatches.push({ route, params });
      if (route.method === method) {
        return { route, params, methodAllowed: true, allowedMethods: null };
      }
    }

    if (pathMatches.length > 0) {
      return {
        route: null,
        params: null,
        methodAllowed: false,
        allowedMethods: [...new Set(pathMatches.map(({ route }) => route.method))].sort()
      };
    }

    return { route: null, params: null, methodAllowed: true, allowedMethods: null };
  }

  handle(request, context = {}) {
    if (!isApiRequestPacket(request)) {
      return null;
    }

    const apiRequest = normalizeApiRequestPacket(request);

    if (!apiRequest.request_id) {
      return createError({
        request: apiRequest,
        status: 400,
        code: "bad_request",
        message: "request_id is required",
        now: this.now
      });
    }

    const method = String(apiRequest.method ?? "GET").toUpperCase();
    const target = parseRequestTarget(apiRequest.resource);
    const match = this.find(method, target.path);

    if (!match.methodAllowed) {
      return createError({
        request: apiRequest,
        status: 405,
        code: "method_not_allowed",
        message: `${method} ${target.path} is not allowed`,
        data: { allowed_methods: match.allowedMethods },
        now: this.now
      });
    }

    if (!match.route) {
      return createError({
        request: apiRequest,
        status: 404,
        code: "not_found",
        message: `${method} ${target.path} is not registered`,
        now: this.now
      });
    }

    try {
      if (
        context.security?.tokenAuth?.enforceScope &&
        match.route.scope &&
        !hasRequiredScope(context.auth?.claims, match.route.scope)
      ) {
        return createError({
          request: apiRequest,
          status: 403,
          code: "insufficient_scope",
          message: `${method} ${target.path} requires scope ${match.route.scope}`,
          data: { required_scope: match.route.scope },
          now: this.now
        });
      }

      if (match.route.rateLimitKey && context.consumeRateLimit) {
        const rate = context.consumeRateLimit(match.route.rateLimitKey);
        if (!rate.ok) {
          return createError({
            request: apiRequest,
            status: rate.status,
            code: rate.error.code,
            message: rate.error.message,
            now: this.now
          });
        }
      }

      if (match.route.replayProtection && context.checkReplay) {
        const replay = context.checkReplay(extractCommandId(apiRequest));
        if (!replay.ok) {
          return createError({
            request: apiRequest,
            status: replay.status,
            code: replay.error.code,
            message: replay.error.message,
            now: this.now
          });
        }
      }

      const result = match.route.handler({
        request: apiRequest,
        method,
        path: target.path,
        query: target.query,
        params: match.params,
        body: apiRequest.body ?? null,
        stateCache: this.stateCache,
        now: this.now,
        startedAt: this.startedAt,
        router: this,
        auth: context.auth ?? null,
        security: context.security ?? null
      });
      return createResponse({ request: apiRequest, result, now: this.now });
    } catch (error) {
      return createError({
        request: apiRequest,
        status: 500,
        code: "internal_error",
        message: error.message,
        now: this.now
      });
    }
  }
}
