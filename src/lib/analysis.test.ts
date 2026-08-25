import { describe, expect, it } from "vitest";
import { RuleAnalysisEngine } from "./analysis";
import { mockNotices, starterTopic } from "./mock-data";

describe("RuleAnalysisEngine", () => {
  const engine = new RuleAnalysisEngine();

  it("대중교통 체계 개편 공고를 우선 추천한다", () => {
    const result = engine.analyze(mockNotices[0], starterTopic);
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.positiveReasons.length).toBeGreaterThan(0);
    expect(result.confidence).toBe("높음");
  });

  it("제외 키워드가 있는 청소 공고를 낮게 평가한다", () => {
    const result = engine.analyze(mockNotices[3], starterTopic);
    expect(result.score).toBeLessThan(50);
    expect(result.penalties.some((item) => item.includes("제외 키워드"))).toBe(true);
  });

  it("명시적인 자격 조건은 적합도와 분리해 확인 필요로 표시한다", () => {
    const result = engine.analyze(mockNotices[2], starterTopic);
    expect(result.eligibilityStatus).toBe("확인 필요");
    expect(result.score).toBeGreaterThan(0);
  });
});
