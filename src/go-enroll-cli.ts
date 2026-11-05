import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { z } from "zod";
import { BusServiceSchema } from "./bus-service";
import { GoAccountError } from "./go-account";
import { GoAuthError } from "./go-auth";
import { GoBusError } from "./go-bus-types";
import { enrollGoAccount, GO_IDENTITY_TERMS_URL } from "./go-enroll";

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new GoAuthError("configuration");
  const parsed = z
    .object({
      GO_BUS_SERVICE: BusServiceSchema,
      GO_APP_RESOURCES: z.string().min(1),
      GO_SESSION_FILE: z
        .string()
        .min(1)
        .default(join(homedir(), ".config/tmoney-go-mcp/session.json")),
      GO_OS_SDK: z
        .string()
        .regex(/^\d{1,3}$/)
        .default("37"),
      GO_OS_RELEASE: z
        .string()
        .regex(/^\d{1,3}(?:\.\d+)*$/)
        .default("17"),
      GO_COUNTRY: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .default("KR"),
    })
    .safeParse(process.env);
  if (!parsed.success) throw new GoAuthError("configuration");
  const config = parsed.data;
  const silent = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const input = createInterface({
    input: process.stdin,
    output: silent,
    terminal: true,
    historySize: 0,
  });
  const abort = new AbortController();
  input.once("SIGINT", () => abort.abort());
  const ask = async (label: string) => {
    process.stdout.write(label);
    const answer = await input.question("", { signal: abort.signal });
    process.stdout.write("\n");
    return answer;
  };
  try {
    process.stdout.write(
      `티머니GO 계정 연결\n개인정보 수집 및 이용동의: ${GO_IDENTITY_TERMS_URL}\n`,
    );
    const consent = await ask("약관을 읽고 동의하면 '동의'를 입력하세요: ");
    if (consent !== "동의") return;
    const status = await enrollGoAccount(
      {
        service: config.GO_BUS_SERVICE,
        resourcesPath: config.GO_APP_RESOURCES,
        sessionPath: config.GO_SESSION_FILE,
        device: { uuid: crypto.randomUUID(), osVer: config.GO_OS_SDK },
        osRelease: config.GO_OS_RELEASE,
        country: config.GO_COUNTRY,
      },
      {
        enterIdentity: async () => ({
          triggerType: "APP_SCHEME",
          userName: await ask("이름 (입력 내용은 표시하지 않습니다): "),
          userPhone: await ask("휴대전화번호 11자리: "),
          userBirthday: await ask("생년월일 8자리: "),
        }),
        approveToss: async () => {
          await ask("휴대전화의 토스 앱에서 인증을 완료한 뒤 Enter를 누르세요: ");
        },
      },
    );
    process.stdout.write(
      status.naverPay.registration === "registered" && status.naverPay.billingReferenceAvailable
        ? "계정 연결과 등록된 네이버페이 조회를 완료했습니다.\n"
        : "계정은 연결됐습니다. 네이버페이 자동결제 등록 상태를 앱에서 확인해주세요.\n",
    );
  } finally {
    input.close();
    silent.end();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const code =
      error instanceof GoAuthError || error instanceof GoAccountError || error instanceof GoBusError
        ? error.code
        : "connection_failed";
    process.stderr.write(`계정 연결을 완료하지 못했습니다 (${code}).\n`);
    process.exitCode = 1;
  }
}
