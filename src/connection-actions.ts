import { z } from "zod";
import type { ConnectionAuth } from "./connection-auth";
import {
  ConnectionError,
  type ConnectionSession,
  type ConnectionSessions,
} from "./connection-sessions";
import { GoAuthError } from "./go-auth";
import { TossIdentitySchema } from "./go-auth-types";
import type { OAuthService } from "./oauth-service";
import type { StateStorage } from "./transient-state";
import type { UserStore } from "./user-store";
import type { UserId } from "./user-types";

export type ConnectionOptions = {
  readonly baseUrl: URL;
  readonly users: UserStore;
  readonly oauth: OAuthService;
  readonly auth?: Pick<ConnectionAuth, "start" | "finish">;
  readonly disconnect: (userId: UserId) => Promise<unknown>;
  readonly osVer: string;
  readonly now?: () => number;
  readonly state?: StateStorage;
};

export class ConnectionActions {
  constructor(
    private readonly options: ConnectionOptions,
    private readonly sessions: ConnectionSessions,
  ) {}

  async run(
    path: string,
    token: string,
    session: ConnectionSession,
    form: Record<string, string>,
  ): Promise<Response | undefined> {
    this.sessions.assertCurrent(token, session);
    if (path === "/connect/consent" && session.phase === "consent") {
      if (
        !z
          .strictObject({
            csrf: z.string(),
            goTerms: z.literal("yes"),
            accountAccess: z.literal("yes"),
          })
          .safeParse(form).success
      )
        throw new ConnectionError("input");
      session.phase = "identity";
    } else if (path === "/connect/start" && session.phase === "identity") {
      await this.start(token, session, form);
    } else if (path === "/connect/finish" && session.phase === "waiting") {
      this.onlyCsrf(form);
      await this.finish(token, session);
    } else if (path === "/connect/authorize" && session.phase === "connected") {
      this.onlyCsrf(form);
      this.connected(session);
      if (!session.oauth || !session.user) throw new ConnectionError("input");
      const response = this.options.oauth.completeAuthorization(
        session.oauth.handle,
        session.user.userId,
      );
      delete session.oauth;
      return response;
    } else if (path === "/connect/disconnect" && session.phase === "connected") {
      this.onlyCsrf(form);
      this.connected(session);
      if (!session.user) throw new ConnectionError("input");
      const userId = session.user.userId;
      this.options.oauth.disconnectUser(userId);
      this.sessions.disconnect(userId);
      await this.options.disconnect(userId);
    } else if (path === "/connect/restart" && session.phase !== "connected") {
      this.onlyCsrf(form);
      delete session.challenge;
      delete session.user;
      session.phase = "consent";
    } else throw new ConnectionError("input");
    this.sessions.rotate(session);
    delete session.message;
    return undefined;
  }

  connected(session: ConnectionSession): void {
    if (
      !session.user ||
      this.options.users.status(session.user.userId)?.connectionId !== session.user.connectionId
    )
      throw new ConnectionError("expired");
  }

  private onlyCsrf(form: Record<string, string>): void {
    if (!z.strictObject({ csrf: z.string() }).safeParse(form).success)
      throw new ConnectionError("input");
  }

  private async start(token: string, session: ConnectionSession, form: Record<string, string>) {
    if (
      !z
        .strictObject({
          csrf: z.string(),
          userName: z.string(),
          userPhone: z.string(),
          userBirthday: z.string(),
        })
        .safeParse(form).success
    )
      throw new GoAuthError("input");
    const { userName, userPhone, userBirthday } = form;
    const input = TossIdentitySchema.safeParse({
      triggerType: "APP_SCHEME",
      userName,
      userPhone,
      userBirthday,
    });
    if (!input.success) throw new GoAuthError("input");
    if (!this.options.auth) throw new GoAuthError("configuration");
    this.sessions.chargeStart(session);
    const device = { uuid: crypto.randomUUID(), osVer: this.options.osVer };
    const result = await this.options.auth.start(device, input.data);
    this.sessions.assertCurrent(token, session);
    const { appScheme, ...request } = result;
    session.challenge = { device, request, appScheme };
    session.phase = "waiting";
    session.finishes = 0;
  }

  private async finish(token: string, session: ConnectionSession) {
    const challenge = session.challenge;
    if (!challenge || !this.options.auth) throw new ConnectionError("input");
    if (session.finishes >= 5) throw new ConnectionError("capacity");
    session.finishes++;
    this.sessions.checkpoint();
    const result = await this.options.auth.finish(challenge.device, challenge.request);
    this.sessions.assertCurrent(token, session);
    const connection = this.options.users.connect(result.credentials);
    session.user = { userId: connection.userId, connectionId: connection.connectionId };
    delete session.challenge;
    session.phase = "connected";
  }
}
