import type { AnalysisEngine, AnalysisResult, BidNotice, Confidence, Evidence, Topic } from "./types";

const normalize = (value: string) => value.toLowerCase().replace(/\s/g, "");

function keywordEvidence(notice: BidNotice, keyword: string): Evidence[] {
  const evidence: Evidence[] = [];
  if (normalize(notice.title).includes(normalize(keyword))) evidence.push({ label: "용역명 일치", text: `용역명에 “${keyword}”가 확인되었습니다.`, source: "입찰공고명", location: "공고명" });
  for (const attachment of notice.attachments.filter((item) => item.status === "분석 완료")) {
    if (normalize(attachment.extractedText ?? "").includes(normalize(keyword))) evidence.push({ label: "첨부문서 일치", text: `첨부문서에서 “${keyword}”가 확인되었습니다.`, source: attachment.name, location: "추출 텍스트" });
  }
  return evidence;
}

export class RuleAnalysisEngine implements AnalysisEngine {
  analyze(notice: BidNotice, topic: Topic): AnalysisResult {
    const analyzedAttachments = notice.attachments.filter((item) => item.status === "분석 완료");
    const title = normalize(notice.title);
    const attachmentText = normalize(analyzedAttachments.map((item) => item.extractedText ?? "").join(" "));
    const titleMatches = topic.includeKeywords.filter((keyword) => title.includes(normalize(keyword)));
    const documentMatches = topic.includeKeywords.filter((keyword) => attachmentText.includes(normalize(keyword)));
    const excluded = topic.excludeKeywords.filter((keyword) => title.includes(normalize(keyword)) || attachmentText.includes(normalize(keyword)));

    // 적합도는 공고명과 실제 추출된 첨부문서의 키워드 근거만으로 계산한다.
    const titleScore = Math.min(40, titleMatches.length * 20);
    const documentScore = Math.min(60, documentMatches.length * 20);
    const overlapBonus = titleMatches.filter((keyword) => documentMatches.includes(keyword)).length * 5;
    const score = excluded.length ? 0 : Math.min(100, titleScore + documentScore + overlapBonus);
    const confidence: Confidence = analyzedAttachments.length > 0 ? "높음" : "낮음";
    const eligibilityStatus = notice.qualifications.some((qualification) => /직접생산|정보통신공사업|건물위생/.test(qualification)) ? "확인 필요" : "충족 가능";
    const grade = score >= 85 ? "매우 높음" : score >= 70 ? "높음" : score >= 50 ? "보통" : "낮음";
    const reasons = topic.includeKeywords.flatMap((keyword) => keywordEvidence(notice, keyword)).slice(0, 5);
    const penalties = excluded.length ? [`제외 키워드 “${excluded.join("”, “")}”가 확인되었습니다.`] : !titleMatches.length && !documentMatches.length ? ["용역명과 분석 완료 첨부문서에서 포함 키워드를 찾지 못했습니다."] : [];

    return {
      score, grade, confidence, eligibilityStatus,
      summary: reasons.length ? `용역명 및 첨부문서에서 ${[...new Set([...titleMatches, ...documentMatches])].map((keyword) => `“${keyword}”`).join(", ")} 근거를 확인했습니다.` : "용역명과 분석 완료 첨부문서에서 주제 관련 키워드를 찾지 못했습니다.",
      components: [{ name: "용역명 키워드", score: titleScore, maxScore: 40 }, { name: "첨부문서 키워드", score: documentScore, maxScore: 60 }],
      positiveReasons: reasons.length ? reasons : [{ label: "키워드 미일치", text: "용역명과 분석 완료 첨부문서에서 포함 키워드를 찾지 못했습니다.", source: "공고명·첨부문서", location: "키워드 분석" }],
      penalties, uncertainties: analyzedAttachments.length ? [] : ["분석 완료된 첨부문서가 없어 점수를 부여할 수 없습니다."],
    };
  }
}
