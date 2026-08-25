import { hasAdminSession } from "@/lib/admin-session";
import { PublicRepository } from "@/lib/repository";

export async function currentRepository() {
  return { user: null, isAdmin: await hasAdminSession(), repository: new PublicRepository() };
}
