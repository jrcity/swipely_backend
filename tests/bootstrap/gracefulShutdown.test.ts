import { describe, expect, it, vi } from "vitest";
import { GracefulShutdown } from "../../src/bootstrap/gracefulShutdown.js";

describe("GracefulShutdown", () => {
  it("pauses every participant before draining and exits cleanly", async () => {
    const events: string[] = [];
    const exit = vi.fn() as unknown as (code: number) => never;
    const shutdown = new GracefulShutdown(
      [
        {
          name: "worker-a",
          beginDrain: () => events.push("pause-a"),
          drain: () => events.push("drain-a"),
        },
        {
          name: "worker-b",
          beginDrain: () => events.push("pause-b"),
          drain: () => events.push("drain-b"),
        },
      ],
      1_000,
      exit,
    );

    await shutdown.shutdown("SIGTERM");

    expect(events.indexOf("pause-a")).toBeLessThan(events.indexOf("drain-a"));
    expect(events.indexOf("pause-b")).toBeLessThan(events.indexOf("drain-b"));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("forces an exit when draining exceeds the grace period", async () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    const shutdown = new GracefulShutdown(
      [{ name: "slow-worker", drain: () => new Promise(() => undefined) }],
      1,
      exit,
    );

    await shutdown.shutdown("SIGINT");

    expect(exit).toHaveBeenCalledWith(1);
  });
});
