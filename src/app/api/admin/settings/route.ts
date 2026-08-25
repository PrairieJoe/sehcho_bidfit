import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase";
import { defaultTopic } from "@/lib/topic-default";

export async function GET() {
  try { await requireAdmin(); const db = createSupabaseAdminClient(); const { data: topic } = await db.from("topics").select("*").order("created_at").limit(1).maybeSingle(); const { data: key } = await db.from("app_settings").select("updated_at").eq("key", "NARAJANGTEO_SERVICE_KEY").maybeSingle(); return NextResponse.json({ topic: topic ?? { id: "default", ...defaultTopic }, hasNarajangteoKey: Boolean(key), keyUpdatedAt: key?.updated_at ?? null }); } catch { return NextResponse.json({ message: "관리자 권한이 필요합니다." }, { status: 403 }); }
}

export async function PATCH(request: Request) {
  try { await requireAdmin(); const body = await request.json() as { topic?: Partial<typeof defaultTopic>; narajangteoServiceKey?: string }; const db = createSupabaseAdminClient(); if (body.topic) { const topic = body.topic; const { data: existing } = await db.from("topics").select("id").order("created_at").limit(1).maybeSingle(); const row = { user_id: null, name: topic.name ?? defaultTopic.name, description: topic.description ?? defaultTopic.description, capabilities: topic.capabilities ?? defaultTopic.capabilities, include_keywords: topic.includeKeywords ?? defaultTopic.includeKeywords, exclude_keywords: topic.excludeKeywords ?? defaultTopic.excludeKeywords, business_types: topic.businessTypes ?? defaultTopic.businessTypes, regions: topic.regions ?? defaultTopic.regions, min_budget: topic.minBudget ?? null, max_budget: topic.maxBudget ?? null, minimum_days: topic.minimumDays ?? defaultTopic.minimumDays, threshold: topic.threshold ?? defaultTopic.threshold }; if (existing) await db.from("topics").update(row).eq("id", existing.id); else await db.from("topics").insert(row); } if (body.narajangteoServiceKey?.trim()) await db.from("app_settings").upsert({ key: "NARAJANGTEO_SERVICE_KEY", value: body.narajangteoServiceKey.trim(), updated_at: new Date().toISOString() }); return NextResponse.json({ ok: true }); } catch (error) { return NextResponse.json({ message: error instanceof Error ? error.message : "관리자 설정 저장에 실패했습니다." }, { status: 400 }); }
}
