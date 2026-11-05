import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoCredentialStore } from "../src/go-credentials";
import { enrollGoAccount } from "../src/go-enroll";

const directories: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(
  busResponse: unknown = { errCode: "00000", USR_SNO: "synthetic-bus-member" },
) {
  const directory = await mkdtemp(join(tmpdir(), "go-enroll-"));
  directories.push(directory);
  const resourcesPath = join(directory, "strings.xml");
  await writeFile(
    resourcesPath,
    '<resources><string name="crypt_key_salt">synthetic-salt</string></resources>',
  );
  const events: string[] = [];
  const completionBodies: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      events.push(path);
      if (path.endsWith("/toss/auth"))
        return Response.json({
          rstCd: 200,
          dta: {
            rspCd: "0000",
            data: {
              txId: "synthetic-private-transaction",
              reqSno: "synthetic-private-request",
              moappMbrsSno: "synthetic-member",
              appScheme: "supertoss://toss-cert/v2/sign/user/auth/id?txId=synthetic-transaction",
            },
          },
        });
      if (path.endsWith("/toss/authResult")) {
        completionBodies.push(await request.json());
        return Response.json({
          rstCd: 200,
          dta: {
            rspCd: "0000",
            data: {
              prsnAuthScsYn: "Y",
              joinYn: "Y",
              ageDvsCd: "1",
              authTkn: "synthetic-private-token",
              moappMbrsSno: "synthetic-member",
            },
          },
        });
      }
      if (path.endsWith("/uptMbrsAuthTknInfo"))
        return Response.json({ rstCd: 200, dta: { authTkn: "synthetic-renewed-token" } });
      if (path.endsWith("/inqrPymMnsListAtPym"))
        return Response.json({
          rstCd: 200,
          dta: {
            npayautPymInfo: {
              cardCpNm: "synthetic-company",
              cardNum4th: "9999",
              automaticPayId: "synthetic-private-billing",
            },
            npayPymInfo: { displayYn: "Y" },
          },
        });
      if (path.endsWith("/getUsrSno.do")) return Response.json(busResponse);
      return new Response("Unexpected synthetic route", { status: 404 });
    },
  });
  servers.push(server);
  const transport = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      return fetch(new Request(new URL(new URL(request.url).pathname, server.url), request));
    },
    { preconnect: fetch.preconnect },
  );
  const config = {
    service: "intercity" as const,
    resourcesPath,
    sessionPath: join(directory, "session.json"),
    device: { uuid: "synthetic-installation", osVer: "37" },
    osRelease: "17",
    country: "KR",
  };
  const ui = {
    enterIdentity: async () => {
      events.push("user-entered-identity");
      return {
        triggerType: "APP_SCHEME",
        userName: "Synthetic User",
        userPhone: "01000000000",
        userBirthday: "19900101",
      } as const;
    },
    approveToss: async () => {
      events.push("user-approved-toss");
    },
  };
  return { config, transport, ui, events, completionBodies };
}

test("enrollment waits for user approval, renews, verifies both services, then saves credentials", async () => {
  const { config, transport, ui, events, completionBodies } = await fixture();
  const result = await enrollGoAccount(config, ui, transport);
  expect(completionBodies).toEqual([
    {
      txId: "synthetic-private-transaction",
      reqSno: "synthetic-private-request",
      moappMbrsSno: "synthetic-member",
      encYn: "Y",
    },
  ]);
  expect(events).toEqual([
    "user-entered-identity",
    "/api/mbrs/auth/v2/toss/auth",
    "user-approved-toss",
    "/api/mbrs/auth/v2/toss/authResult",
    "/api/mbrs/v2/uptMbrsAuthTknInfo",
    "/api/pym/v2/inqrPymMnsListAtPym",
    "/tgx/tgoxzz/user/getUsrSno.do",
  ]);
  expect(result.connection).toBe("connected");
  expect(result.naverPay.registration).toBe("registered");
  expect(JSON.stringify(result)).not.toMatch(/synthetic|9999/);
  const saved = await new GoCredentialStore(config.sessionPath).read();
  expect(saved.token).toBe("synthetic-renewed-token");
  expect(saved.busUserNumber).toBe("synthetic-bus-member");
});

test("failure to map the bus account does not publish a partial session file", async () => {
  const { config, transport, ui } = await fixture({ errCode: "00000", USR_SNO: "" });
  await expect(enrollGoAccount(config, ui, transport)).rejects.toMatchObject({ code: "response" });
  expect(await Bun.file(config.sessionPath).exists()).toBe(false);
});

test("the private CLI refuses captured or piped input", async () => {
  const child = Bun.spawn([process.execPath, "run", "src/go-enroll-cli.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stdout).text()).toBe("");
  expect(await new Response(child.stderr).text()).toContain("configuration");
});
