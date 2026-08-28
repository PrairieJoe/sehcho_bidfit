import { describe, expect, it } from "vitest";
import { isGeminiQuotaResponse } from "./gemini";

describe("isGeminiQuotaResponse", () => {
  it("classifies a Gemini HTTP 429 as a quota failure", () => {
    expect(isGeminiQuotaResponse(429, "Too many requests")).toBe(true);
  });

  it("classifies RESOURCE_EXHAUSTED even when the gateway uses another status", () => {
    expect(isGeminiQuotaResponse(400, "RESOURCE_EXHAUSTED: free tier quota reached")).toBe(true);
  });

  it("does not misclassify ordinary model errors as a quota failure", () => {
    expect(isGeminiQuotaResponse(500, "internal model error")).toBe(false);
  });
});
