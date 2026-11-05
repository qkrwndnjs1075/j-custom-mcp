import { createHash } from "node:crypto";
import { z } from "zod";
import { BookingStore } from "../src/booking-store";
import { BookingSpecSchema, bookingBinding } from "../src/booking-types";
import { GoCredentialsSchema } from "../src/go-credential-types";
import { GoPurchaseHoldSchema } from "../src/go-purchase-types";
import { UserStore } from "../src/user-store";
import { UserIdSchema } from "../src/user-types";
import { UserVault } from "../src/user-vault";
import production, { TmoneyApplication, type WorkerEnv } from "../src/workers/index";
import { DurableSqlDatabase } from "../src/workers/sql-database";

const markerSchema = z.object({ userId: UserIdSchema, bookingId: z.uuid() });

export class AlarmTestApplication extends TmoneyApplication {
  constructor(
    private readonly testState: DurableObjectState,
    private readonly testEnv: WorkerEnv,
  ) {
    super(testState, testEnv);
  }

  override async fetch(request: Request): Promise<Response> {
    switch (new URL(request.url).pathname) {
      case "/__test/alarm":
        return Response.json({ alarm: await this.testState.storage.getAlarm() });
      case "/__test/seed-recovery": {
        const vault = new UserVault(Buffer.from(this.testEnv.GO_VAULT_KEY, "base64"));
        const users = new UserStore({
          db: new DurableSqlDatabase(this.testState.storage, "accounts"),
          vault,
        });
        const credentials = GoCredentialsSchema.parse({
          token: "synthetic-token",
          uuid: "synthetic-device",
          appCode: "MIC",
          appVer: "2.7.1",
          osKnd: "A",
          osVer: "34",
          moappMbrsSno: "synthetic-member",
          busUserNumber: "synthetic-bus-user",
          refreshSalt: "synthetic-salt",
          osRelease: "14",
          country: "KR",
        });
        const connected = users.connect(credentials);
        const hash = createHash("sha256").update(connected.userId).digest("hex");
        const store = new BookingStore(
          new DurableSqlDatabase(this.testState.storage, `u_${hash}_booking`),
          connected.userId,
        );
        const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        const compactDate = date.replaceAll("-", "");
        const spec = BookingSpecSchema.parse({
          version: 2,
          payment: { method: "naver_pay_auto" },
          discounts: { mode: "none" },
          seatPolicy: { mode: "first_available", order: "ascending", passengerOrder: ["adult"] },
          idempotencyKey: crypto.randomUUID(),
          criteria: {
            service: "intercity",
            departureId: "0000001",
            arrivalId: "0000002",
            date,
            maxFareKrw: 20000,
            time: "00:00",
            endTime: "23:59",
            minSeats: 1,
            passengers: { adults: 1, students: 0, children: 0 },
            ranking: ["departure_time"],
          },
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          intervalSeconds: 300,
        });
        const hold = GoPurchaseHoldSchema.parse({
          trip: {
            service: "intercity",
            row: {
              rotid: "00123",
              rotsqno: "01",
              alcndt: compactDate,
              alcnsqno: "0007",
              timdte: compactDate,
              timtim: "1000",
              timtimo: "0930",
              terfri: "0000001",
              tertoi: "0000002",
              terfro: "0000099",
              tertoo: "0000088",
              busgrao: "1",
              corcodo: "03",
              afcownrdvscd: "01",
              adltfee: 15000,
              lintim: "0130",
              tckpay: "Y",
            },
            expectedAdultFareKrw: 15000,
            expectedTotalFareKrw: 15000,
            passengers: { adults: 1, students: 0, children: 0 },
            departureTerminal: { TER_COD: "0000001" },
            arrivalTerminal: { TER_COD: "0000002" },
          },
          info: { tckfee1: "15000", totcnt: "4", seatlist: [{ "01": "Y" }], DIST: "100" },
          seats: [
            { seat: "01", holdId: "synthetic-hold", ticketKind: "IG00", passengerType: "adult" },
          ],
        });
        const created = store.create(
          spec,
          bookingBinding({ ...credentials, connectionId: connected.connectionId }),
        );
        let record = store.read(created.booking.id);
        if (!record) throw new TypeError("Missing synthetic booking");
        for (const stage of ["holding", "held", "reserving"] as const) {
          record = store.transition(record, stage, {
            hold,
            purchaseMonth: compactDate.slice(0, 6),
            selection: {
              service: "intercity",
              departureDate: compactDate,
              departureTime: "100000",
              departureName: "Synthetic A",
              arrivalName: "Synthetic B",
              seat: 1,
              seats: [1],
              fareKrw: 15000,
            },
          });
          if (!record) throw new TypeError("Synthetic booking transition lost");
        }
        await this.testState.storage.put("test-recovery", {
          userId: connected.userId,
          bookingId: record.id,
        });
        await this.testState.storage.setAlarm(Date.now() + 300000);
        return Response.json({ stage: record.stage, issueAttempted: record.issueAttempted });
      }
      case "/__test/recovery": {
        const marker = markerSchema.parse(await this.testState.storage.get("test-recovery"));
        const hash = createHash("sha256").update(marker.userId).digest("hex");
        const store = new BookingStore(
          new DurableSqlDatabase(this.testState.storage, `u_${hash}_booking`),
          marker.userId,
        );
        const record = store.read(marker.bookingId);
        return Response.json({
          stage: record?.stage,
          lastError: record?.lastError,
          issueAttempted: record?.issueAttempted,
        });
      }
      case "/__test/run-alarm":
        await super.alarm();
        return Response.json({ completed: true });
      default:
        return super.fetch(request);
    }
  }
}

export default production;
