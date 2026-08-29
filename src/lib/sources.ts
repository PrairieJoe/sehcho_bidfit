import type { Attachment, BidNotice, BidSource, BusinessType, NoticeStatus } from "@/lib/types";
import { runtimeEnv } from "@/lib/runtime-env";
import https from "node:https";

const BASE_URL = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService";
// BidFit's product scope is service procurements only. Do not mix goods,
// construction, or foreign-purchase notices into the user's result set.
const LIST_ENDPOINTS: Array<[BusinessType, string]> = [["용역", "getBidPblancListInfoServc"]];
const PAGE_SIZE = 100;

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
async function fetchApiPage(url: URL, businessType: string) {
  let lastError: unknown;
  // data.go.kr occasionally drops TLS connections from hosted runners. Use a
  // longer bounded backoff here because the worker is allowed to run for hours
  // and a transient transport failure must not create a false partial batch.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      // GitHub-hosted runners intermittently fail during undici's address
      // selection for apis.data.go.kr. Force IPv4 through Node's native HTTPS
      // client before falling back to fetch, which otherwise can time out even
      // when the runner's curl IPv4 probe succeeds.
      const payload = await new Promise<unknown>((resolve, reject) => {
        const request = https.get(url, { family: 4, headers: { Accept: "application/json" } }, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => {
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) { reject(new Error(`나라장터 ${businessType} 목록 조회 실패 (${status})`)); return; }
            try { resolve(JSON.parse(body)); } catch { reject(new Error(`나라장터 ${businessType} JSON 응답 파싱 실패`)); }
          });
        });
        request.setTimeout(45_000, () => request.destroy(new Error("나라장터 HTTPS 응답 시간 초과")));
        request.on("error", reject);
      });
      return payload as { response?: { header?: { resultCode?: string | number; resultMsg?: string }; body?: { items?: { item?: Record<string, unknown> | Record<string, unknown>[] } | Record<string, unknown>[]; totalCount?: number } } };
    } catch (error) {
      lastError = error;
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.warn(`[Nara] ${businessType} API transport attempt ${attempt}/5 failed: ${detail}`);
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`나라장터 ${businessType} 목록 조회 실패`);
}
function statusOf(item: Record<string, unknown>, closesAt: string): NoticeStatus {
  if (value(item, "reNtceYn", "rePblancYn") === "Y") return "재공고";
  if (value(item, "bidNtceKindNm", "ntceKindNm").includes("정정")) return "정정";
  return new Date(closesAt).getTime() < Date.now() ? "마감" : "신규";
}
function attachmentsOf(item: Record<string, unknown>, key: string): Attachment[] {
  const attachments: Attachment[] = [];
  const seen = new Set<string>();
  const add = (name: string, sourceUrl: string, fallback: string) => {
    const url = sourceUrl.trim();
    const fileName = name.trim() || fallback;
    if (!url && !name.trim()) return;
    const dedupe = url || `${fileName}-${attachments.length}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    attachments.push({ id: `${key}-file-${attachments.length + 1}`, name: fileName, kind: (fileName || url).split("?")[0].split(".").pop()?.toUpperCase() || "FILE", status: "대기", sourceUrl: url });
  };
  for (let index = 1; index <= 10; index += 1) {
    const name = value(item, `ntceSpecFileNm${index}`, `bidNtceSpecFileNm${index}`, `fileNm${index}`);
    const sourceUrl = value(item, `ntceSpecDocUrl${index}`, `bidNtceSpecDocUrl${index}`, `fileUrl${index}`);
    add(name, sourceUrl, `첨부파일 ${index}`);
  }
  // The standard notice document and supplementary documents are also valid
  // attachments, but are not always duplicated in ntceSpecFileNm* fields.
  add(value(item, "stdNtceDocNm", "stdNtceFileNm"), value(item, "stdNtceDocUrl"), "표준 공고문서");
  for (let index = 1; index <= 5; index += 1) add(value(item, `sptDscrptFileNm${index}`), value(item, `sptDscrptDocUrl${index}`), `보충설명문서 ${index}`);
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
  async listNotices(windowStart: Date, windowEnd: Date, diagnostics: string[] = []): Promise<BidNotice[]> {
    const serviceKey = this.configuredKey?.trim().replace(/%([0-9A-Fa-f]{2})/g, (match) => String.fromCharCode(parseInt(match.slice(1), 16)));
    if (!serviceKey) throw new Error("NARAJANGTEO_SERVICE_KEY가 설정되지 않았습니다.");
    const notices: BidNotice[] = [];
    // Query the service catalogue and walk every page in the requested window.
    await Promise.all(LIST_ENDPOINTS.map(async ([businessType, endpoint]) => {
      // Large 24-hour catalogue requests intermittently exceed the upstream
      // response window. Smaller contiguous slices keep the same requested
      // analysis window while making each transport request bounded.
      const sliceSize = 6 * 60 * 60 * 1_000;
      for (let sliceStartMs = windowStart.getTime(); sliceStartMs < windowEnd.getTime(); sliceStartMs += sliceSize) {
        const sliceStart = new Date(sliceStartMs);
        const sliceEnd = new Date(Math.min(sliceStartMs + sliceSize, windowEnd.getTime()));
        for (let pageNo = 1; ; pageNo += 1) {
          const url = new URL(`${BASE_URL}/${endpoint}`);
          [["serviceKey", serviceKey], ["type", "json"], ["numOfRows", String(PAGE_SIZE)], ["pageNo", String(pageNo)], ["inqryDiv", "1"], ["inqryBgnDt", requestDate(sliceStart)], ["inqryEndDt", requestDate(sliceEnd)]].forEach(([key, entry]) => url.searchParams.set(key, entry));
          const payload = await fetchApiPage(url, businessType);
          const header = payload.response?.header;
          if (header && String(header.resultCode ?? "00") !== "00") throw new Error(`나라장터 ${businessType} API 오류 (${header.resultCode}): ${header.resultMsg ?? "응답 오류"}`);
          const body = payload.response?.body;
          const raw = Array.isArray(body?.items) ? body.items : body?.items?.item;
          if (!body) throw new Error(`나라장터 ${businessType} API 응답 형식 오류`);
          const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
          diagnostics.push(`${businessType}: ${requestDate(sliceStart)}~${requestDate(sliceEnd)} code=${String(header?.resultCode ?? "00")}, total=${String(body.totalCount ?? 0)}, items=${items.length}`);
          const attachmentFieldCount = items.filter((entry) => attachmentsOf(entry, `${value(entry, "bidNtceNo", "bidNtceNoInfo")}-${value(entry, "bidNtceOrd", "bidNtceOrdNo") || "000"}`).length > 0).length;
          console.log(`[Nara] ${businessType} 목록 ${items.length}건 중 첨부 필드 확인 ${attachmentFieldCount}건`);
          notices.push(...items.map((entry) => normalizeItem(entry, businessType)).filter((entry): entry is BidNotice => Boolean(entry)));
          const totalCount = Number(payload.response?.body?.totalCount ?? 0);
          if (items.length < PAGE_SIZE || pageNo * PAGE_SIZE >= totalCount) break;
        }
      }
    }));
    // Keep every unique notice returned by the service query.
    const unique = Array.from(new Map(notices.map((notice) => [notice.id, notice])).values());
    return unique;
  }
}
export function getBidSource(): BidSource {
  if (!runtimeEnv("NARAJANGTEO_SERVICE_KEY")) throw new Error("NARAJANGTEO_SERVICE_KEY가 설정되지 않았습니다.");
  return new NarajangteoBidSource();
}
