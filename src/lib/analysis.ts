import type { AnalysisEngine, AnalysisResult, BidNotice, Confidence, Evidence, Topic } from "./types";

const normalize = (value: string) => value.toLowerCase().replace(/\s/g, "");
const toCurrency = (value: number | null) => value ? `${Math.round(value / 10_000).toLocaleString("ko-KR")}만원` : "금액 미정";

function directEvidence(notice: BidNotice, keyword: string): Evidence | undefined {
  const source = `${notice.title} ${notice.description} ${notice.tasks.join(" ")} ${notice.attachments.map((item) => item.name + " " + (item.extractedText ?? "")).join(" ")}`;
  if (!normalize(source).includes(normalize(keyword))) return undefined;
  const attachment = notice.attachments.find((item) => item.status === "분석 완료") ?? notice.attachments[0];
  return {
    label: "핵심 주제 일치",
    text: `“${keyword}” 관련 과업이 공고의 목적 또는 수행 범위에 포함됩니다.`,
    source: attachment?.name ?? "입찰공고 기본정보",
    location: attachment?.extractedText && normalize(attachment.extractedText).includes(normalize(keyword)) ? "추출 텍스트" : attachment?.pages ? "p. 1~3" : "공고 요약",
  };
}

export class RuleAnalysisEngine implements AnalysisEngine {
  analyze(notice: BidNotice, topic: Topic): AnalysisResult {
    const corpus = normalize([notice.title, notice.description, notice.tasks.join(" "), notice.qualifications.join(" "), ...notice.attachments.map((item) => `${item.name} ${item.extractedText ?? ""}`)].join(" "));
    const keywordMatches = topic.includeKeywords.filter((keyword) => corpus.includes(normalize(keyword)));
    const excluded = topic.excludeKeywords.filter((keyword) => corpus.includes(normalize(keyword)));
    const typeMatch = topic.businessTypes.includes(notice.businessType);
    const budgetMatch = (!topic.minBudget || !notice.budget || notice.budget >= topic.minBudget) && (!topic.maxBudget || !notice.budget || notice.budget <= topic.maxBudget);
    const daysRemaining = Math.ceil((new Date(notice.closesAt).getTime() - Date.now()) / 86_400_000);
    const hasSuccessfulAttachment = notice.attachments.some((item) => item.status === "분석 완료");
    const failedAttachments = notice.attachments.filter((item) => item.status === "다운로드 실패" || item.status === "추출 실패");

    const core = Math.min(35, keywordMatches.length * 7 + (notice.tasks.some((task) => /분석|설계|개편|운영/.test(task)) ? 8 : 2));
    const capability = Math.min(20, keywordMatches.length * 3 + (topic.capabilities.includes("교통 데이터") && /데이터|수요예측/.test(notice.description + notice.tasks.join(" ")) ? 8 : 3));
    const concepts = Math.min(15, keywordMatches.length * 3);
    const business = typeMatch ? 10 : 2;
    const location = topic.regions.includes("전국") || topic.regions.includes(notice.region) ? 5 : 2;
    const budget = budgetMatch ? 5 : 1;
    const schedule = daysRemaining < 0 ? 0 : daysRemaining >= topic.minimumDays ? 5 : 1;
    const evidence = hasSuccessfulAttachment ? 5 : 2;
    const penalty = excluded.length ? 35 : 0;
    const score = Math.max(0, Math.min(100, core + capability + concepts + business + location + budget + schedule + evidence - penalty));
    const confidence: Confidence = hasSuccessfulAttachment && failedAttachments.length === 0 ? "높음" : hasSuccessfulAttachment ? "보통" : "낮음";
    const eligibilityStatus = notice.qualifications.some((qualification) => /직접생산|정보통신공사업|건물위생/.test(qualification)) ? "확인 필요" : "충족 가능";
    const grade = score >= 85 ? "매우 높음" : score >= 70 ? "높음" : score >= 50 ? "보통" : "낮음";
    const reasons = keywordMatches.slice(0, 3).map((keyword) => directEvidence(notice, keyword)).filter((item): item is Evidence => Boolean(item));
    if (reasons.length === 0) reasons.push({ label: "사업 개요", text: "주제 관련 직접 근거가 제한적이므로 원문 확인이 필요합니다.", source: "입찰공고 기본정보", location: "공고 요약" });
    const penalties: string[] = [];
    if (!typeMatch) penalties.push(`대상 업무가 ${topic.businessTypes.join("·")} 중심 설정과 다릅니다.`);
    if (!budgetMatch) penalties.push(`공고 금액(${toCurrency(notice.budget)})이 설정 범위를 벗어납니다.`);
    if (daysRemaining < topic.minimumDays) penalties.push(daysRemaining < 0 ? "이미 입찰 마감된 공고입니다." : `마감까지 ${daysRemaining}일로 최소 검토기간보다 짧습니다.`);
    if (excluded.length) penalties.push(`제외 키워드 “${excluded.join("”, “")}”가 확인되었습니다.`);
    const uncertainties = failedAttachments.length ? [`${failedAttachments.map((item) => item.name).join(", ")} 분석에 실패했습니다.`] : [];
    if (eligibilityStatus === "확인 필요") uncertainties.push(`필수 조건(${notice.qualifications.join(", ")})의 보유 여부를 확인하세요.`);

    return {
      score,
      grade,
      confidence,
      eligibilityStatus,
      summary: notice.description,
      components: [
        { name: "핵심 과업/목적", score: core, maxScore: 35 },
        { name: "요구 역량/기술", score: capability, maxScore: 20 },
        { name: "필수 개념", score: concepts, maxScore: 15 },
        { name: "사업 유형", score: business, maxScore: 10 },
        { name: "기관·지역", score: location, maxScore: 5 },
        { name: "예산", score: budget, maxScore: 5 },
        { name: "일정", score: schedule, maxScore: 5 },
        { name: "근거 충분성", score: evidence, maxScore: 5 },
      ],
      positiveReasons: reasons,
      penalties,
      uncertainties,
    };
  }
}
