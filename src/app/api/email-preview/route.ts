import { repository } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const notices = repository.listNotices().filter((item) => item.analysis && item.analysis.score >= repository.getTopic().threshold && item.status !== "마감");
  return Response.json({
    subject: `[BidFit] 오늘의 신규 추천 ${notices.length}건`,
    notices: notices.map((notice) => ({ title: notice.title, score: notice.analysis?.score, agency: notice.demandAgency, closesAt: notice.closesAt })),
  });
}
