import { describe, expect, it } from "vitest";
import { chooseAnalysisWindow } from "./collection-window";

describe("chooseAnalysisWindow", () => {
  const end = new Date("2026-08-28T00:00:00.000Z");

  it("always uses the latest 24 hours for the daily analysis unit", () => {
    const result = chooseAnalysisWindow(100, end, 100);
    expect(result.windowHours).toBe(24);
    expect(result.useShortWindow).toBe(true);
    expect(result.windowStart.toISOString()).toBe("2026-08-27T00:00:00.000Z");
    expect(result.queryCount).toBe(1);
  });

  it("keeps the execution timestamp as the exclusive upper-bound reference", () => {
    const result = chooseAnalysisWindow(101, end, 100);
    expect(result.windowHours).toBe(24);
    expect(result.useShortWindow).toBe(true);
    expect(result.windowStart.toISOString()).toBe("2026-08-27T00:00:00.000Z");
    expect(result.windowEnd.toISOString()).toBe(end.toISOString());
    expect(result.queryCount).toBe(1);
  });
});
