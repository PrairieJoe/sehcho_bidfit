import { describe, expect, it } from "vitest";
import { chooseAnalysisWindow } from "./collection-window";

describe("chooseAnalysisWindow", () => {
  const end = new Date("2026-08-28T00:00:00.000Z");

  it("keeps 72 hours when the candidate count is within the configured limit", () => {
    const result = chooseAnalysisWindow(100, end, 100);
    expect(result.windowHours).toBe(72);
    expect(result.useShortWindow).toBe(false);
    expect(result.windowStart.toISOString()).toBe("2026-08-25T00:00:00.000Z");
    expect(result.queryCount).toBe(1);
  });

  it("switches to exactly the latest 24 hours when the limit is exceeded", () => {
    const result = chooseAnalysisWindow(101, end, 100);
    expect(result.windowHours).toBe(24);
    expect(result.useShortWindow).toBe(true);
    expect(result.windowStart.toISOString()).toBe("2026-08-27T00:00:00.000Z");
    expect(result.windowEnd.toISOString()).toBe(end.toISOString());
    expect(result.queryCount).toBe(2);
  });
});
