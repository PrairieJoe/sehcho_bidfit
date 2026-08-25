import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { defaultTopic } from "@/lib/topic-default";

function configError(error: unknown) {
  const message = error instanceof Error ? error.message : "관리자 설정을 처리하지 못했습니다.";
  return NextResponse.json({ message }, { status: message.includes("Supabase 환경변수") ? 503 : 403 });
}

export async function GET() {
  try {
    await requireAdmin();
    const db = createSupabaseAdminClient();
    const { data: topic } = await db.from("topics").select("*").order("created_at").limit(1).maybeSingle();
    return NextResponse.json({
      topic: topic ?? { id: "default", ...defaultTopic },
      hasNarajangteoKey: Boolean(process.env.NARAJANGTEO_SERVICE_KEY),
      keySource: "vercel-environment",
    });
  } catch (error) { return configError(error); }
}

export async function PATCH(request: Request) {
  try {
    await requireAdmin();
    const body = await request.json() as { topic?: Partial<typeof defaultTopic> };
    if (!body.topic) return NextResponse.json({ message: "저장할 탐색 주제가 없습니다." }, { status: 400 });
    const db = createSupabaseAdminClient();
    const topic = body.topic;
    const { data: existing } = await db.from("topics").select("id").order("created_at").limit(1).maybeSingle();
    const row = {
      user_id: null,
      name: topic.name ?? defaultTopic.name,
      description: topic.description ?? defaultTopic.description,
      capabilities: topic.capabilities ?? defaultTopic.capabilities,
      include_keywords: topic.includeKeywords ?? defaultTopic.includeKeywords,
      exclude_keywords: topic.excludeKeywords ?? defaultTopic.excludeKeywords,
      business_types: topic.businessTypes ?? defaultTopic.businessTypes,
      regions: topic.regions ?? defaultTopic.regions,
      min_budget: topic.minBudget ?? null,
      max_budget: topic.maxBudget ?? null,
      minimum_days: topic.minimumDays ?? defaultTopic.minimumDays,
      threshold: topic.threshold ?? defaultTopic.threshold,
    };
    if (existing) await db.from("topics").update(row).eq("id", existing.id);
    else await db.from("topics").insert(row);
    return NextResponse.json({ ok: true });
  } catch (error) { return configError(error); }
}
