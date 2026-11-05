import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { harness } from "./harness.mts";

test("internal public transport rejects other destinations and strips private headers", async () => {
  const item = await harness();
  try {
    for (const url of [
      "https://provider.internal/private/payment",
      "https://provider.internal/mrs/readRotLinInf.ajax?target=https://other.example",
      "http://provider.internal/mrs/readRotLinInf.ajax",
    ]) {
      const denied = await item.request(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      });
      assert.equal(denied.status, 400, url);
    }
    assert.deepEqual(item.calls, []);
    const allowed = await item.request("https://provider.internal/mrs/readRotLinInf.ajax", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Bearer synthetic-private",
        cookie: "synthetic-private=value",
        "user-agent": "Untrusted caller",
        referer: "https://other.example",
      },
      body: "",
    });
    assert.equal(allowed.status, 200);
    const routes = z.object({ rotInfList: z.array(z.unknown()) }).parse(await allowed.json());
    assert.ok(routes.rotInfList.length > 0);
    assert.deepEqual(item.calls, ["www.kobus.co.kr/mrs/readRotLinInf.ajax"]);
    assert.deepEqual(item.unexpected, []);
  } finally {
    await item.close();
  }
});
