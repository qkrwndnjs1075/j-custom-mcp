import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ConnectionPageModel } from "./connect-page";
import type { GoDevice, TossChallenge } from "./go-auth";
import type { OAuthAuthorizationView, OAuthService } from "./oauth-service";
import type { TossAppScheme } from "./toss-launch";
import { ConnectionSnapshotSchema, type StateStorage } from "./transient-state";
import type { UserId } from "./user-types";

export class ConnectionError extends Error {
  override readonly name = "ConnectionError";
  constructor(readonly code: "expired" | "csrf" | "capacity" | "busy" | "input") {
    super(code);
  }
}

// This mutable record belongs only to its browser flow; transitions are locked across awaits.
export type ConnectionSession = {
  phase: ConnectionPageModel["phase"];
  csrf: string;
  expiresAt: number;
  busy: boolean;
  attempts: number;
  finishes: number;
  oauth?: OAuthAuthorizationView;
  challenge?: {
    readonly device: GoDevice;
    readonly request: TossChallenge;
    readonly appScheme: TossAppScheme;
  };
  user?: { readonly userId: UserId; readonly connectionId: string };
  message?: string;
};

const secret = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class ConnectionSessions {
  readonly #sessions = new Map<string, ConnectionSession>();
  readonly #now: () => number;
  #rateWindow = 0;
  #rateCount = 0;

  constructor(
    now: () => number = Date.now,
    private readonly state?: StateStorage,
    private readonly oauthCodec?: Pick<
      OAuthService,
      "serializeAuthorization" | "restoreAuthorization"
    >,
  ) {
    this.#now = now;
    const value = state?.get("connections");
    if (value === undefined) return;
    const snapshot = ConnectionSnapshotSchema.parse(value);
    this.#rateWindow = snapshot.rateWindow;
    this.#rateCount = snapshot.rateCount;
    for (const [key, stored] of snapshot.sessions) {
      const { oauth, challenge, user, message, ...base } = stored;
      const session: ConnectionSession = {
        ...base,
        busy: false,
        ...(challenge ? { challenge } : {}),
        ...(user ? { user } : {}),
        ...(message ? { message } : {}),
        ...(oauth !== undefined && oauthCodec
          ? { oauth: oauthCodec.restoreAuthorization(oauth) }
          : {}),
      };
      if (stored.busy) {
        session.phase = "error";
        delete session.challenge;
        session.csrf = secret();
      }
      this.#sessions.set(key, session);
    }
  }

  checkpoint(): void {
    if (!this.state) return;
    this.state.set("connections", {
      rateWindow: this.#rateWindow,
      rateCount: this.#rateCount,
      sessions: [...this.#sessions].map(([key, session]) => {
        const { oauth, ...base } = session;
        return [
          key,
          {
            ...base,
            ...(oauth && this.oauthCodec
              ? {
                  oauth: this.oauthCodec.serializeAuthorization(oauth),
                }
              : {}),
          },
        ];
      }),
    });
  }

  create() {
    for (const [key, value] of this.#sessions) {
      if (value.expiresAt <= this.#now()) this.#sessions.delete(key);
    }
    if (this.#sessions.size >= 128) throw new ConnectionError("capacity");
    const token = secret();
    const session: ConnectionSession = {
      phase: "consent",
      csrf: secret(),
      expiresAt: this.#now() + 900_000,
      busy: false,
      attempts: 0,
      finishes: 0,
    };
    this.#sessions.set(digest(token), session);
    this.checkpoint();
    return { token, session };
  }

  get(token: string | undefined): ConnectionSession | undefined {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const session = this.#sessions.get(digest(token));
    return session && session.expiresAt > this.#now() ? session : undefined;
  }

  restartUrl(token: string | undefined): string | undefined {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const session = this.#sessions.get(digest(token));
    return session?.oauth?.restartUrl ?? (session ? "/connect" : undefined);
  }

  assertCurrent(token: string, session: ConnectionSession): void {
    if (
      this.get(token) !== session ||
      (session.oauth && session.oauth.expiresAt * 1000 <= this.#now())
    )
      throw new ConnectionError("expired");
  }

  csrf(session: ConnectionSession, value: string | undefined): void {
    if (
      !value ||
      !/^[A-Za-z0-9_-]{43}$/.test(value) ||
      !timingSafeEqual(Buffer.from(value), Buffer.from(session.csrf))
    )
      throw new ConnectionError("csrf");
  }

  rotate(session: ConnectionSession): void {
    session.csrf = secret();
    this.checkpoint();
  }

  chargeStart(session: ConnectionSession): void {
    const window = Math.floor(this.#now() / 60_000);
    if (window !== this.#rateWindow) {
      this.#rateWindow = window;
      this.#rateCount = 0;
    }
    if (session.attempts >= 3 || this.#rateCount >= 20) throw new ConnectionError("capacity");
    session.attempts++;
    this.#rateCount++;
    this.checkpoint();
  }

  remove(token: string): void {
    this.#sessions.delete(digest(token));
    this.checkpoint();
  }

  disconnect(userId: UserId): void {
    for (const session of this.#sessions.values()) {
      if (session.user?.userId !== userId) continue;
      delete session.user;
      delete session.challenge;
      delete session.oauth;
      session.phase = "disconnected";
      session.csrf = secret();
    }
    this.checkpoint();
  }
}
