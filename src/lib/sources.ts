import type { Attachment, BidNotice, BidSource, BusinessType, NoticeStatus } from "@/lib/types";
import { runtimeEnv } from "@/lib/runtime-env";

const BASE_URL = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService";
const LIST_ENDPOINTS: Array<[BusinessType, string]> = [["용역", "getBidPblancListInfoServc"], ["물품", "getBidPblancListInfoThng"], ["공사", "getBidPblancListInfoCnstwk"], ["외자", "getBidPblancListInfoFrgcpt"]];
// Keep one invocation comfortably inside the Vercel Hobby function budget.
// The next daily run continues with the overlapping time window.
const MAX_PAGES_PER_TYPE = 1;

function value(item: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) { const found = item[key]; if (found !== undefined && found !== null && String(found).trim()) return String(found).trim(); }
  return "";
}
function apiDate(input: string) {
  // 나라장터는 `202608261125`, `2026-08-26 11:25:00`처럼 서로 다른
  // 날짜 표기를 반환한다. 구분자를 제거한 뒤 같은 규칙으로 해석한다.
  const match = input.replace(/\D/g, "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/);
  if (!match) return "";
  const [, year, month, day, hour = "00", minute = "00"] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:00+09:00`).toISOString();
}
function requestDate(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).reduce<Record<string, string>>((memo, part) => ({ ...memo, [part.type]: part.value }), {});
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}`;
}
function statusOf(item: Record<string, unknown>, closesAt: string): NoticeStatus {
  if (value(item, "reNtceYn", "rePblancYn") === "Y") return "재공고";
  if (value(item, "bidNtceKindNm", "ntceKindNm").includes("정정")) return "정정";
  return new Date(closesAt).getTime() < Date.now() ? "마감" : "신규";
}
function attachmentsOf(item: Record<string, unknown>, key: string): Attachment[] {
  const attachments: Attachment[] = [];
  for (let index = 1; index <= 10; index += 1) {
    const name = value(item, `ntceSpecFileNm${index}`, `bidNtceSpecFileNm${index}`, `fileNm${index}`);
    const sourceUrl = value(item, `ntceSpecDocUrl${index}`, `bidNtceSpecDocUrl${index}`, `fileUrl${index}`);
    if (!name && !sourceUrl) continue;
    attachments.push({ id: `${key}-file-${index}`, name: name || `첨부파일 ${index}`, kind: (name || sourceUrl).split("?")[0].split(".").pop()?.toUpperCase() || "FILE", status: "대기", sourceUrl });
  }
  return attachments;
}
function normalizeItem(item: Record<string, unknown>, businessType: BusinessType): BidNotice | null {
  const bidNumber = value(item, "bidNtceNo", "bidNtceNoInfo");
  if (!bidNumber) return null;
  const order = value(item, "bidNtceOrd", "bidNtceOrdNo") || "000";
  const closesAt = apiDate(value(item, "bidClseDt", "bidClseDate"));
  const budget = Number(value(item, "asignBdgtAmt", "presmptPrce", "bdgtAmt").replace(/,/g, "")) || null;
  return { id: `${bidNumber}-${order}`, bidNumber, order, title: value(item, "bidNtceNm", "bidNtceName") || "제목 미확인 공고", businessType, status: statusOf(item, closesAt), agency: value(item, "ntceInsttNm", "pubPrcrmntCorpNm") || "발주기관 미확인", demandAgency: value(item, "dminsttNm", "dmndInsttNm") || "수요기관 미확인", region: value(item, "prtcptPsblRgnNm", "rgnNm") || "전국", publishedAt: apiDate(value(item, "bidNtceDt", "ntceDt")), closesAt, budget, budgetLabel: budget ? `${Math.round(budget / 10_000).toLocaleString("ko-KR")}만원` : "금액 미정", contractMethod: value(item, "bidMethdNm", "cntrctCnclsMthdNm") || "전자입찰", detailUrl: value(item, "bidNtceDtlUrl", "ntceDtlUrl"), description: value(item, "bidNtceDtlCn", "bidNtceNm") || "나라장터 API에서 수집한 공고입니다.", tasks: [value(item, "prtcptLmtCn", "bidMethdNm")].filter(Boolean), qualifications: [value(item, "prtcptPsblRgnNm")].filter(Boolean), changeSummary: value(item, "chgDt", "reNtceYn") === "Y" ? "재공고 또는 변경 이력이 확인되었습니다." : undefined, attachments: attachmentsOf(item, `${bidNumber}-${order}`), reviewState: "검토 전" };
}

export class NarajangteoBidSource implements BidSource {
  constructor(private readonly configuredKey = runtimeEnv("NARAJANGTEO_SERVICE_KEY")) {}
  async listNotices(windowStart: Date, windowEnd: Date, allowFallback = true, diagnostics: string[] = []): Promise<BidNotice[]> {
    const serviceKey = this.configuredKey?.trim().replace(/%([0-9A-Fa-f]{2})/g, (match) => String.fromCharCode(parseInt(match.slice(1), 16)));
    if (!serviceKey) throw new Error("NARAJANGTEO_SERVICE_KEY가 설정되지 않았습니다.");
    const notices: BidNotice[] = [];
    // Query the four catalogues concurrently. A single slow catalogue must not
    // hold the whole daily run indefinitely.
    await Promise.all(LIST_ENDPOINTS.map(async ([businessType, endpoint]) => {
      for (let pageNo = 1; pageNo <= MAX_PAGES_PER_TYPE; pageNo += 1) {
      const url = new URL(`${BASE_URL}/${endpoint}`);
      [["serviceKey", serviceKey], ["type", "json"], ["numOfRows", "20"], ["pageNo", String(pageNo)], ["inqryDiv", "1"], ["inqryBgnDt", requestDate(windowStart)], ["inqryEndDt", requestDate(windowEnd)]].forEach(([key, entry]) => url.searchParams.set(key, entry));
      const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`나라장터 ${businessType} 목록 조회 실패 (${response.status})`);
      const payload = await response.json() as { response?: { header?: { resultCode?: string | number; resultMsg?: string }; body?: { items?: { item?: Record<string, unknown> | Record<string, unknown>[] } | Record<string, unknown>[]; totalCount?: number } } };
      const header = payload.response?.header;
      if (header && String(header.resultCode ?? "00") !== "00") throw new Error(`나라장터 ${businessType} API 오류 (${header.resultCode}): ${header.resultMsg ?? "응답 오류"}`);
      const body = payload.response?.body;
      const raw = Array.isArray(body?.items) ? body.items : body?.items?.item;
      if (!body) throw new Error(`나라장터 ${businessType} API 응답 형식 오류`);
      const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
      diagnostics.push(`${businessType}: code=${String(header?.resultCode ?? "00")}, total=${String(body.totalCount ?? 0)}, items=${items.length}`);
      notices.push(...items.map((entry) => normalizeItem(entry, businessType)).filter((entry): entry is BidNotice => Boolean(entry)));
      if (items.length < 20 || pageNo * 20 >= Number(payload.response?.body?.totalCount ?? 0)) break;
      }
    }));
    // Keep every unique notice returned by the four business-type queries.
    // The previous MVP safeguard sliced this combined result to ten records,
    // which made a valid 72-hour collection appear incomplete.
    const unique = Array.from(new Map(notices.map((notice) => [notice.id, notice])).values());
    // Some public-data API partitions lag behind the current date. Keep the daily
    // 72-hour query first, then widen once so a temporary empty partition does not
    // appear as a successful zero-result batch.
    if (allowFallback && !unique.length && windowEnd.getTime() - windowStart.getTime() <= 72 * 3_600_000 + 60_000) {
      const widened = await this.listNotices(new Date(windowEnd.getTime() - 7 * 86_400_000), windowEnd, false, diagnostics);
      if (!widened.length) throw new Error(`나라장터 조회 결과가 없습니다. ${diagnostics.join(" / ")}`);
      return widened;
    }
    return unique;
  }
}
export function getBidSource(): BidSource {
  if (!runtimeEnv("NARAJANGTEO_SERVICE_KEY")) throw new Error("NARAJANGTEO_SERVICE_KEY가 설정되지 않았습니다.");
  return new NarajangteoBidSource();
}
