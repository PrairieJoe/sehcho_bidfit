import { describe, expect, it } from "vitest";
import { RuleAnalysisEngine } from "./analysis";
import { defaultTopic } from "./topic-default";
import type { BidNotice, Topic } from "./types";

const topic: Topic = { id: "test", ...defaultTopic };
const notice = (overrides: Partial<BidNotice>): BidNotice => ({ id: "notice", bidNumber: "2026", order: "001", title: "대중교통 노선 개편 연구", businessType: "용역", status: "신규", agency: "기관", demandAgency: "기관", region: "전국", publishedAt: "2026-08-25T00:00:00Z", closesAt: "2026-09-05T00:00:00Z", budget: 100_000_000, budgetLabel: "1억원", contractMethod: "협상", detailUrl: "https://example.com", description: "대중교통 수요 분석과 환승 체계 개편", tasks: ["교통 데이터 분석", "노선 설계"], qualifications: [], attachments: [{ id: "file", name: "제안요청서.pdf", kind: "PDF", status: "분석 완료" }], reviewState: "검토 전", ...overrides });

describe("RuleAnalysisEngine", () => {
  const engine = new RuleAnalysisEngine();

  it("대중교통 체계 개편 공고를 우선 추천한다", () => {
    const result = engine.analyze(notice({}), topic);
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.positiveReasons.length).toBeGreaterThan(0);
    expect(result.confidence).toBe("높음");
  });

  it("제외 키워드가 있는 청소 공고를 낮게 평가한다", () => {
    const result = engine.analyze(notice({ title: "청소 용역", description: "청소 업무", tasks: ["시설 청소"] }), topic);
    expect(result.score).toBeLessThan(50);
    expect(result.penalties.some((item) => item.includes("제외 키워드"))).toBe(true);
  });

  it("명시적인 자격 조건은 적합도와 분리해 확인 필요로 표시한다", () => {
    const result = engine.analyze(notice({ qualifications: ["정보통신공사업 면허"] }), topic);
    expect(result.eligibilityStatus).toBe("확인 필요");
    expect(result.score).toBeGreaterThan(0);
  });
});
