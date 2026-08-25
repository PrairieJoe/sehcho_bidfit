import { mockNotices } from "@/lib/mock-data";
import type { BidNotice, BidSource } from "@/lib/types";

export class MockBidSource implements BidSource {
  async listNotices(_windowStart: Date, _windowEnd: Date): Promise<BidNotice[]> {
    return structuredClone(mockNotices);
  }
}

/**
 * Production adapter seam. The implementation intentionally does not run
 * until NARAJANGTEO_SERVICE_KEY is supplied and endpoint fields are verified.
 */
export class NarajangteoBidSource implements BidSource {
  async listNotices(_windowStart: Date, _windowEnd: Date): Promise<BidNotice[]> {
    if (!process.env.NARAJANGTEO_SERVICE_KEY) {
      throw new Error("NARAJANGTEO_SERVICE_KEY가 설정되지 않았습니다.");
    }
    throw new Error("나라장터 운영 API 어댑터는 인증키와 최신 명세 검증 후 활성화됩니다.");
  }
}

export function getBidSource(): BidSource {
  return process.env.NARAJANGTEO_SERVICE_KEY ? new NarajangteoBidSource() : new MockBidSource();
}
