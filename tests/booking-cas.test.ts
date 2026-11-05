import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { harness, specification } from "./booking-fixtures";

test("allows exactly one hold claim across independent processes", async () => {
  // Given
  const item = harness();
  const created = await item.runner.create(specification());
  const source = `import { BookingStore } from ${JSON.stringify(new URL("../src/booking-store.ts", import.meta.url).href)};
    const store = new BookingStore(process.argv[1], "synthetic-principal");
    const record = store.read(process.argv[2]);
    if (!record) throw new Error("Missing synthetic authorization");
    console.log("ready");
    await Bun.stdin.text();
    console.log(store.transition(record, "holding") ? "winner" : "loser");
    store.close();`;
  const children = [0, 1].map(() => {
    const process = Bun.spawn(
      [Bun.which("bun") ?? "bun", "-e", source, item.path, created.booking.id],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return { process, reader: process.stdout.getReader() };
  });
  try {
    for (const child of children) {
      const ready = await child.reader.read();
      expect(new TextDecoder().decode(ready.value).trim()).toBe("ready");
    }
    // When
    for (const child of children) child.process.stdin.end();
    const outcomes = await Promise.all(
      children.map(async (child) => {
        let output = "";
        for (;;) {
          const chunk = await child.reader.read();
          if (chunk.done) break;
          output += new TextDecoder().decode(chunk.value);
        }
        const error = await new Response(child.process.stderr).text();
        expect(await child.process.exited, error).toBe(0);
        return output.trim();
      }),
    );
    // Then
    expect(outcomes.sort()).toEqual(["loser", "winner"]);
    expect(item.store.get(created.booking.id)?.stage).toBe("holding");
  } finally {
    for (const child of children) child.process.kill();
    await Promise.all(children.map(({ process }) => process.exited));
    item.store.close();
    rmSync(item.directory, { recursive: true });
  }
});
