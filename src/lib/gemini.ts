import type { AnalysisResult, BidNotice, Evidence, Topic } from "@/lib/types";

// Flash-Lite keeps the daily batch economical while still returning structured Korean analysis.
// Google currently lists this as the supported replacement for retired 2.x Flash-Lite.
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
const MAX_INPUT_CHARS = 30_000;
const MAX_OUTPUT_TOKENS = 700;

type GeminiResponse = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
type GeminiAnalysis = { score?: number; summary?: string; reasons?: string[]; penalties?: string[]; eligibilityStatus?: AnalysisResult["eligibilityStatus"]; confidence?: AnalysisResult["confidence"] };

function grade(score: number): AnalysisResult["grade"] { return score >= 85 ? "매우 높음" : score >= 70 ? "높음" : score >= 50 ? "보통" : "낮음"; }
function parseJson(text: string): GeminiAnalysis | null { try { return JSON.parse(text.replace(/^```json\s*|\s*```$/g, "").trim()) as GeminiAnalysis; } catch { return null; } }

export function compactDocumentText(notice: BidNotice) {
  const body = notice.attachments.filter((item) => item.status === "분석 완료" && item.extractedText).map((item) => `[첨부파일: ${item.name}]\n${item.extractedText}`).join("\n\n");
  return (body || `[첨부문서 없음]\n공고명: ${notice.title}\n공고 설명: ${notice.description}`).slice(0, MAX_INPUT_CHARS);
}

export async function analyzeWithGemini(notice: BidNotice, topic: Topic): Promise<AnalysisResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  const documentText = compactDocumentText(notice);
  if (!apiKey) throw new Error("Gemini API 키가 설정되지 않았습니다.");
  const hasAttachments = notice.attachments.some((item) => item.status === "분석 완료" && item.extractedText);
  const prompt = `당신은 한국 공공입찰 검토 보조자입니다. ${hasAttachments ? "아래는 이미지·표를 제외하고 추출한 공고 첨부문서 텍스트입니다. 문서 내용이 최우선 근거입니다." : "첨부문서가 제공되지 않아 공고명과 공고 설명만으로 보수적으로 판단합니다. 결과에 첨부문서 없음과 공고명 기반 분석임을 명시하세요."} 제목만으로 단정하지 말고 제공된 정보만 근거로 관심 주제와의 적합도를 0~100 정수로 평가하세요. 원문을 길게 인용하지 말고, 짧은 요약 근거만 작성하세요. 제외 키워드가 있으면 score는 0입니다. 반드시 JSON만 반환하세요.\n\n관심 주제: ${topic.name}\n설명: ${topic.description}\n포함 키워드: ${topic.includeKeywords.join(", ") || "없음"}\n제외 키워드: ${topic.excludeKeywords.join(", ") || "없음"}\n\n반환 형식: {"score":0,"summary":"...","reasons":["..."],"penalties":["..."],"confidence":"높음|보통|낮음","eligibilityStatus":"충족 가능|확인 필요|조건 불일치"}\n\n분석 입력:\n${documentText}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.1 } }), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`Gemini API HTTP ${response.status}: ${detail}`);
  }
  const payload = await response.json() as GeminiResponse;
  const parsed = parseJson(payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "");
  if (!parsed || !Number.isFinite(parsed.score)) throw new Error("Gemini 응답 JSON을 해석하지 못했습니다.");
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
  const evidence: Evidence[] = (parsed.reasons ?? []).slice(0, 4).map((text) => ({ label: hasAttachments ? "Gemini 문서 분석" : "Gemini 공고명 기반 fallback", text: String(text).slice(0, 360), source: hasAttachments ? "첨부문서 텍스트" : "공고명·공고 설명", location: "AI 요약" }));
  return { score, grade: grade(score), confidence: parsed.confidence === "높음" || parsed.confidence === "낮음" ? parsed.confidence : "보통", eligibilityStatus: parsed.eligibilityStatus === "조건 불일치" || parsed.eligibilityStatus === "확인 필요" ? parsed.eligibilityStatus : "충족 가능", summary: String(parsed.summary ?? (hasAttachments ? "첨부문서 텍스트를 분석했습니다." : "첨부문서가 없어 공고명과 설명을 기준으로 분석했습니다.")).slice(0, 800), components: [{ name: hasAttachments ? "Gemini 첨부문서 분석" : "Gemini 공고명 fallback 분석", score, maxScore: 100 }], positiveReasons: evidence.length ? evidence : [{ label: hasAttachments ? "Gemini 문서 분석" : "Gemini 공고명 기반 fallback", text: hasAttachments ? "첨부문서 텍스트를 기준으로 적합도를 평가했습니다." : "첨부문서가 없어 공고명과 설명을 기준으로 보수적으로 평가했습니다.", source: hasAttachments ? "첨부문서 텍스트" : "공고명·공고 설명", location: "AI 요약" }], penalties: (parsed.penalties ?? []).map(String).slice(0, 4), uncertainties: [hasAttachments ? "이미지·표·도면은 분석 범위에서 제외했습니다." : "첨부문서가 없어 공고명·공고 설명 기반의 제한적 분석입니다."], aiModel: MODEL, promptVersion: hasAttachments ? "text-only-v1" : "notice-fallback-v1" };
}
