import { describe, expect, it } from "vitest";
import { RuleAnalysisEngine } from "./analysis";
import { defaultTopic } from "./topic-default";
import type { BidNotice, Topic } from "./types";

const topic: Topic = { id: "test", ...defaultTopic };
const notice = (overrides: Partial<BidNotice>): BidNotice => ({ id: "notice", bidNumber: "2026", order: "001", title: "대중교통 노선 개편 연구", businessType: "용역", status: "신규", agency: "기관", demandAgency: "기관", region: "전국", publishedAt: "2026-08-25T00:00:00Z", closesAt: "2026-09-05T00:00:00Z", budget: 100_000_000, budgetLabel: "1억원", contractMethod: "협상", detailUrl: "https://example.com", description: "대중교통 수요 분석과 환승 체계 개편", tasks: ["교통 데이터 분석", "노선 설계"], qualifications: [], attachments: [{ id: "file", name: "제안요청서.pdf", kind: "PDF", status: "분석 완료", extractedText: "대중교통 수요 분석과 버스 노선 환승 체계 개편" }], reviewState: "검토 전", ...overrides });

describe("RuleAnalysisEngine", () => {
  const engine = new RuleAnalysisEngine();

  it("용역명과 첨부문서 키워드가 일치한 공고를 우선 추천한다", () => {
    const result = engine.analyze(notice({}), topic);
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.positiveReasons.length).toBeGreaterThan(0);
    expect(result.confidence).toBe("높음");
  });

  it("제외 키워드가 있는 청소 공고는 0점 처리한다", () => {
    const result = engine.analyze(notice({ title: "청소 용역", attachments: [{ id: "file", name: "제안요청서.pdf", kind: "PDF", status: "분석 완료", extractedText: "청소 업무" }] }), topic);
    expect(result.score).toBe(0);
    expect(result.penalties.some((item) => item.includes("제외 키워드"))).toBe(true);
  });

  it("업무유형·지역·예산·마감일은 점수에 반영하지 않는다", () => {
    const result = engine.analyze(notice({ title: "일반 용역", businessType: "물품", region: "서울", budget: 1, closesAt: "2026-08-26T00:00:00Z", attachments: [{ id: "file", name: "제안요청서.pdf", kind: "PDF", status: "분석 완료", extractedText: "관련 없는 문서" }] }), topic);
    expect(result.score).toBe(0);
  });
});
