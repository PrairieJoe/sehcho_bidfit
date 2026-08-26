import { createSupabaseAdminClient } from "@/lib/supabase";

export type SetupCheck = { key: string; label: string; status: "ready" | "missing" | "error"; detail: string; action: string };

export async function getSetupStatus() {
  const checks: SetupCheck[] = [
    { key: "admin", label: "관리자 코드", status: process.env.ADMIN_ACCESS_CODE ? "ready" : "missing", detail: process.env.ADMIN_ACCESS_CODE ? "설정됨" : "Vercel 환경변수에 없습니다.", action: "Vercel Production에 ADMIN_ACCESS_CODE를 등록하세요." },
    { key: "supabase-url", label: "Supabase URL", status: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL ? "ready" : "missing", detail: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL ? "설정됨" : "Vercel 환경변수에 없습니다.", action: "Vercel Production에 SUPABASE_URL을 등록하세요." },
    { key: "supabase-service", label: "Supabase 서버 키", status: process.env.SUPABASE_SERVICE_ROLE_KEY ? "ready" : "missing", detail: process.env.SUPABASE_SERVICE_ROLE_KEY ? "설정됨" : "Vercel 환경변수에 없습니다.", action: "Vercel Production에 SUPABASE_SERVICE_ROLE_KEY를 등록하세요." },
    { key: "nara", label: "나라장터 API Key", status: process.env.NARAJANGTEO_SERVICE_KEY ? "ready" : "missing", detail: process.env.NARAJANGTEO_SERVICE_KEY ? "설정됨" : "Vercel 환경변수에 없습니다.", action: "Vercel Production에 NARAJANGTEO_SERVICE_KEY를 등록하세요." },
    { key: "cron", label: "Cron 비밀값", status: process.env.CRON_SECRET ? "ready" : "missing", detail: process.env.CRON_SECRET ? "설정됨" : "Vercel 환경변수에 없습니다.", action: "Vercel Production에 CRON_SECRET을 등록하세요." },
  ];
  if (checks.some((check) => check.status !== "ready")) return { ready: false, checks };
  try {
    const db = createSupabaseAdminClient();
    const [topics, notices, runs, storage] = await Promise.all([
      db.from("topics").select("id").limit(1), db.from("notices").select("id").limit(1),
      db.from("batch_runs").select("id").limit(1), db.storage.from("bid-documents").list("", { limit: 1 }),
    ]);
    const databaseError = topics.error ?? notices.error ?? runs.error;
    if (databaseError) throw databaseError;
    if (storage.error) throw storage.error;
    checks.push({ key: "database", label: "Supabase 스키마", status: "ready", detail: "필수 테이블과 Storage 버킷에 연결되었습니다.", action: "" });
  } catch (error) {
    checks.push({ key: "database", label: "Supabase 스키마", status: "error", detail: error instanceof Error ? error.message : "연결 실패", action: "migration과 bid-documents 비공개 버킷을 확인하세요." });
  }
  return { ready: checks.every((check) => check.status === "ready"), checks };
}
