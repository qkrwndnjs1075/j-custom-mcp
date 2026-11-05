import { createHash } from "node:crypto";
import { z } from "zod";
import { AppConfigSchema } from "../app-config";
import { createApplication } from "../application";
import { AuthTokenStore } from "../auth-token-store";
import { TmoneyBusClient } from "../bus-router";
import { KobusExpressClient } from "../express-provider";
import { TmoneyIntercityClient } from "../provider";
import { UserStore } from "../user-store";
import { UserVault } from "../user-vault";
import {
  createRegionalProviderFetch,
  fetchPublicProvider,
  type PublicFetchBinding,
} from "./public-fetch";
import { DurableSqlDatabase } from "./sql-database";
import { DurableStateStorage } from "./state-storage";

export type WorkerEnv = {
  readonly APPLICATION: DurableObjectNamespace;
  readonly PROVIDER_TRANSPORT: PublicFetchBinding;
  readonly GO_VAULT_KEY: string;
  readonly GO_REFRESH_SALT?: string;
  readonly MCP_BASE_URL?: string;
  readonly MCP_ALLOWED_ORIGINS?: string;
  readonly MCP_LIMITS?: string;
};

type Application = Awaited<ReturnType<typeof createApplication>>;

export class TmoneyApplication {
  #application: Promise<Application> | undefined;
  #origin: string | undefined;
  #alarmUpdate: Promise<void> = Promise.resolve();
  #activeEvents = 0;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: WorkerEnv,
  ) {}

  private application(origin?: string): Promise<Application> {
    if (this.#application) return this.#application;
    this.#application = this.state.blockConcurrencyWhile(async () => {
      const encoded = z
        .string()
        .regex(/^[A-Za-z0-9+/]{43}=$/)
        .parse(this.env.GO_VAULT_KEY);
      const key = Buffer.from(encoded, "base64");
      if (key.length !== 32 || key.toString("base64") !== encoded)
        throw new WorkerConfigurationError();
      const accounts = new DurableSqlDatabase(this.state.storage, "accounts");
      const persisted = new DurableStateStorage(accounts, key, "host");
      const savedOrigin = persisted.get("origin");
      const baseUrl = z.url().parse(this.env.MCP_BASE_URL ?? savedOrigin ?? origin);
      const config = AppConfigSchema.parse({
        MCP_BASE_URL: baseUrl,
        MCP_ALLOWED_HOSTS: new URL(baseUrl).hostname,
        MCP_ALLOWED_ORIGINS: this.env.MCP_ALLOWED_ORIGINS ?? "app.vooy.com",
        MCP_LIMITS: this.env.MCP_LIMITS,
        DATA_DIRECTORY: "/data",
      });
      this.#origin = new URL(baseUrl).origin;
      persisted.set("origin", this.#origin);
      const scopedState = (scope: string) => new DurableStateStorage(accounts, key, scope);
      const users = new UserStore(
        { db: accounts, vault: new UserVault(key) },
        { accountLimit: config.MCP_LIMITS.accounts },
      );
      const tokens = new AuthTokenStore(new DurableSqlDatabase(this.state.storage, "oauth"));
      return createApplication(config, {
        users,
        tokens,
        connectionState: scopedState("connections"),
        provider: new TmoneyBusClient(
          new TmoneyIntercityClient(),
          new KobusExpressClient(createRegionalProviderFetch(this.env.PROVIDER_TRANSPORT)),
        ),
        persistence: {
          database: (userId, kind) => {
            const hash = createHash("sha256").update(userId).digest("hex");
            return new DurableSqlDatabase(this.state.storage, `u_${hash}_${kind}`);
          },
          state: scopedState,
        },
        ...(this.env.GO_REFRESH_SALT ? { salt: this.env.GO_REFRESH_SALT } : {}),
      });
    });
    return this.#application;
  }

  private updateAlarm(application: Application): Promise<void> {
    const update = this.#alarmUpdate.then(async () => {
      const current = await this.state.storage.getAlarm();
      const scheduled = application.nextWakeAt();
      const recovery = this.#activeEvents > 0 ? Date.now() + 300_000 : undefined;
      const next = scheduled === undefined ? recovery : Math.min(scheduled, recovery ?? scheduled);
      if (next === undefined) {
        if (current !== null) await this.state.storage.deleteAlarm();
      } else {
        const target = Math.max(Date.now() + 1_000, next);
        if (current === null || current > target || current <= Date.now())
          await this.state.storage.setAlarm(target);
      }
    });
    // Keep subsequent scheduling possible after a failed event; its caller still receives the error.
    this.#alarmUpdate = update.then(
      () => undefined,
      () => undefined,
    );
    return update;
  }

  async fetch(request: Request): Promise<Response> {
    const application = await this.application(new URL(request.url).origin);
    if (new URL(request.url).origin !== this.#origin)
      return new Response("Unexpected origin", { status: 403 });
    const headers = new Headers(request.headers);
    headers.set("Host", new URL(request.url).host);
    const forwarded = new Request(request, { headers });
    this.#activeEvents++;
    try {
      await this.updateAlarm(application);
      const response = await application.fetch(forwarded);
      // A legacy MCP POST may return an SSE response before its tool has finished.
      // Finish that exchange before scheduling work created by the tool.
      if (
        request.method === "POST" &&
        response.headers.get("content-type")?.startsWith("text/event-stream")
      )
        return new Response(await response.arrayBuffer(), response);
      return response;
    } finally {
      this.#activeEvents--;
      await this.updateAlarm(application);
    }
  }

  async alarm(): Promise<void> {
    const application = await this.application();
    this.#activeEvents++;
    try {
      await this.updateAlarm(application);
      await application.tick();
    } finally {
      this.#activeEvents--;
      await this.updateAlarm(application);
    }
  }
}

class WorkerConfigurationError extends Error {
  override readonly name = "WorkerConfigurationError";
  constructor() {
    super("Invalid Worker configuration");
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (new URL(request.url).hostname === "provider.internal") return fetchPublicProvider(request);
    return env.APPLICATION.get(env.APPLICATION.idFromName("application-v1")).fetch(request);
  },
} satisfies ExportedHandler<WorkerEnv>;
