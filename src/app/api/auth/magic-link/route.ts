import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient, createSupabaseServerClient, isSupabaseConfigured } from "@/lib/supabase";

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured()) return NextResponse.json({ message: "Supabase 설정 후 로그인 기능을 사용할 수 있습니다." }, { status: 503 });
  const email = String((await request.json()).email ?? "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return NextResponse.json({ message: "올바른 이메일 주소를 입력하세요." }, { status: 400 });
  const { data: allowed } = await createSupabaseAdminClient().from("allowed_users").select("email").eq("email", email).eq("active", true).maybeSingle();
  if (!allowed) return NextResponse.json({ message: "허용 목록에 없는 이메일입니다. 관리자에게 초대를 요청하세요." }, { status: 403 });
  const client = await createSupabaseServerClient();
  const origin = process.env.NEXT_PUBLIC_SITE_URL || request.nextUrl.origin;
  const { error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: `${origin}/auth/callback` } });
  if (error) return NextResponse.json({ message: "로그인 메일을 보낼 수 없습니다." }, { status: 400 });
  return NextResponse.json({ message: "로그인 링크를 이메일로 보냈습니다." });
}
