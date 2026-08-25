import type { Attachment, BidNotice, BidSource, BusinessType, NoticeStatus } from "@/lib/types";

const BASE_URL = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService";
const LIST_ENDPOINTS: Array<[BusinessType, string]> = [["용역", "getBidPblancListInfoServc"], ["물품", "getBidPblancListInfoThng"], ["공사", "getBidPblancListInfoCnstwk"], ["외자", "getBidPblancListInfoFrgcpt"]];
const MAX_PAGES_PER_TYPE = 5;

function value(item: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) { const found = item[key]; if (found !== undefined && found !== null && String(found).trim()) return String(found).trim(); }
  return "";
}
function apiDate(input: string) {
  const match = input.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})?/);
  if (!match) return new Date().toISOString();
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
  return { id: `${bidNumber}-${order}`, bidNumber, order, title: value(item, "bidNtceNm", "bidNtceName") || "제목 미확인 공고", businessType, status: statusOf(item, closesAt), agency: value(item, "ntceInsttNm", "pubPrcrmntCorpNm") || "발주기관 미확인", demandAgency: value(item, "dminsttNm", "dmndInsttNm") || "수요기관 미확인", region: value(item, "prtcptPsblRgnNm", "rgnNm") || "전국", publishedAt: apiDate(value(item, "bidNtceDt", "ntceDt")), closesAt, budget, budgetLabel: budget ? `${Math.round(budget / 10_000).toLocaleString("ko-KR")}만원` : "금액 미정", contractMethod: value(item, "bidMethdNm", "cntrctCnclsMthdNm") || "전자입찰", detailUrl: value(item, "bidNtceDtlUrl", "ntceDtlUrl") || "https://www.g2b.go.kr", description: value(item, "bidNtceDtlCn", "bidNtceNm") || "나라장터 API에서 수집한 공고입니다.", tasks: [value(item, "prtcptLmtCn", "bidMethdNm")].filter(Boolean), qualifications: [value(item, "prtcptPsblRgnNm")].filter(Boolean), changeSummary: value(item, "chgDt", "reNtceYn") === "Y" ? "재공고 또는 변경 이력이 확인되었습니다." : undefined, attachments: attachmentsOf(item, `${bidNumber}-${order}`), reviewState: "검토 전" };
}

export class NarajangteoBidSource implements BidSource {
  async listNotices(windowStart: Date, windowEnd: Date): Promise<BidNotice[]> {
    const serviceKey = process.env.NARAJANGTEO_SERVICE_KEY;
    if (!serviceKey) throw new Error("NARAJANGTEO_SERVICE_KEY가 설정되지 않았습니다.");
    const notices: BidNotice[] = [];
    for (const [businessType, endpoint] of LIST_ENDPOINTS) for (let pageNo = 1; pageNo <= MAX_PAGES_PER_TYPE; pageNo += 1) {
      const url = new URL(`${BASE_URL}/${endpoint}`);
      [["serviceKey", serviceKey], ["type", "json"], ["numOfRows", "100"], ["pageNo", String(pageNo)], ["inqryDiv", "1"], ["inqryBgnDt", requestDate(windowStart)], ["inqryEndDt", requestDate(windowEnd)]].forEach(([key, entry]) => url.searchParams.set(key, entry));
      const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error(`나라장터 ${businessType} 목록 조회 실패 (${response.status})`);
      const payload = await response.json() as { response?: { body?: { items?: { item?: Record<string, unknown> | Record<string, unknown>[] }; totalCount?: number } } };
      const raw = payload.response?.body?.items?.item;
      const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
      notices.push(...items.map((entry) => normalizeItem(entry, businessType)).filter((entry): entry is BidNotice => Boolean(entry)));
      if (items.length < 100 || pageNo * 100 >= Number(payload.response?.body?.totalCount ?? 0)) break;
    }
    return Array.from(new Map(notices.map((notice) => [notice.id, notice])).values());
  }
}
export function getBidSource(): BidSource {
  if (!process.env.NARAJANGTEO_SERVICE_KEY) throw new Error("NARAJANGTEO_SERVICE_KEY가 설정되지 않았습니다.");
  return new NarajangteoBidSource();
}
