import { hasAdminSession } from "@/lib/admin-session";

export async function requireUser() {
  throw new Error("일반 사용자 로그인은 사용하지 않습니다.");
}

export function unauthorizedResponse() {
  return Response.json({ message: "인증이 필요합니다." }, { status: 401 });
}

export async function requireAdmin() {
  if (!(await hasAdminSession())) throw new Error("관리자 권한이 필요합니다.");
  return true;
}
