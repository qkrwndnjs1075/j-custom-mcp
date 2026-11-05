import { CONNECTION_MESSAGES, renderConnectionPage } from "./connect-page";
import { ConnectionActions, type ConnectionOptions } from "./connection-actions";
import { connectionCookie, connectionForm } from "./connection-request";
import { ConnectionError, type ConnectionSession, ConnectionSessions } from "./connection-sessions";
import { CONNECTION_STYLES } from "./connection-styles";
import { GoAuthError } from "./go-auth";

const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
} as const;

export function createConnectionHandler(options: ConnectionOptions) {
  const secure = options.baseUrl.protocol === "https:";
  const cookieName = secure ? "__Host-tmoney-connect" : "tmoney-connect-local";
  const sessions = new ConnectionSessions(options.now, options.state, options.oauth);
  const actions = new ConnectionActions(options, sessions);
  const page = (session: ConnectionSession, status = 200, cookie?: string) =>
    new Response(renderConnectionPage(session), {
      status,
      headers: {
        ...headers,
        ...(session.phase === "connected" && session.oauth
          ? {
              "Content-Security-Policy": headers["Content-Security-Policy"].replace(
                "form-action 'self'",
                `form-action 'self' ${session.oauth.clientOrigin}`,
              ),
            }
          : {}),
        "Content-Type": "text/html; charset=utf-8",
        ...(cookie
          ? {
              "Set-Cookie": `${cookieName}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900${secure ? "; Secure" : ""}`,
            }
          : {}),
      },
    });
  const redirect = (cookie?: string) =>
    new Response(null, {
      status: 303,
      headers: {
        ...headers,
        Location: "/connect",
        ...(cookie
          ? {
              "Set-Cookie": `${cookieName}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900${secure ? "; Secure" : ""}`,
            }
          : {}),
      },
    });

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/connect" && !url.pathname.startsWith("/connect/")) return undefined;
    if (url.pathname === "/connect/style.css" && request.method === "GET")
      return new Response(CONNECTION_STYLES, {
        headers: { ...headers, "Content-Type": "text/css; charset=utf-8" },
      });
    let token = connectionCookie(request, cookieName);
    let session = sessions.get(token);
    let newSession = false;
    try {
      if (request.method === "GET" && url.pathname === "/connect") {
        const pending = url.searchParams.get("authorization");
        if (url.searchParams.size && (!pending || url.searchParams.size !== 1))
          throw new ConnectionError("input");
        if (pending) {
          if (token) sessions.remove(token);
          const created = sessions.create();
          token = created.token;
          session = created.session;
          newSession = true;
          session.oauth = options.oauth.getAuthorization(pending, token);
          return redirect(token);
        }
        if (!session) {
          if (sessions.restartUrl(token)) throw new ConnectionError("expired");
          const created = sessions.create();
          return page(created.session, 200, created.token);
        }
        if (session.phase === "connected") actions.connected(session);
        return page(session);
      }
      if (request.method !== "POST") return new Response("Not found", { status: 404, headers });
      if (!session || !token) throw new ConnectionError("expired");
      const form = await connectionForm(request, options.baseUrl.origin);
      const { csrf } = form;
      sessions.csrf(session, csrf);
      if (session.busy) throw new ConnectionError("busy");
      session.busy = true;
      try {
        return (await actions.run(url.pathname, token, session, form)) ?? redirect();
      } finally {
        session.busy = false;
      }
    } catch (error) {
      const restartUrl = newSession ? undefined : sessions.restartUrl(token);
      if (token && (newSession || (error instanceof ConnectionError && error.code === "expired"))) {
        sessions.remove(token);
        session = undefined;
      }
      if (error instanceof ConnectionError && error.code === "busy")
        return new Response("Connection request already in progress", { status: 409, headers });
      if (error instanceof ConnectionError && error.code === "csrf")
        return new Response(renderConnectionPage({ phase: "rejected" }), {
          status: 403,
          headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
        });
      if (!session) {
        return new Response(
          renderConnectionPage({
            phase: "error",
            csrf: "",
            message: CONNECTION_MESSAGES.expired,
            ...(restartUrl ? { restartUrl } : {}),
          }),
          {
            status: 410,
            headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
          },
        );
      }
      if (error instanceof GoAuthError && error.code === "input") {
        session.message = CONNECTION_MESSAGES.invalidIdentity;
        return page(session, 400);
      }
      if (
        error instanceof GoAuthError &&
        error.code === "verification_unconfirmed" &&
        session.phase === "waiting"
      ) {
        session.message = CONNECTION_MESSAGES.verificationUnconfirmed;
        return page(session, 400);
      }
      session.phase = "error";
      session.message =
        error instanceof ConnectionError && error.code === "expired"
          ? CONNECTION_MESSAGES.expired
          : CONNECTION_MESSAGES.unavailable;
      if (error instanceof ConnectionError && error.code === "expired") delete session.oauth;
      delete session.challenge;
      return page(session, error instanceof ConnectionError ? 400 : 503);
    } finally {
      sessions.checkpoint();
    }
  };
}
