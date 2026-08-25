import { repository } from "@/lib/store";
import type { Topic } from "@/lib/types";

export async function GET() {
  return Response.json(repository.getTopic());
}

export async function PATCH(request: Request) {
  const patch = await request.json() as Partial<Topic>;
  return Response.json(repository.updateTopic(patch));
}
