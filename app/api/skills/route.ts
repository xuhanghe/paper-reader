import { listInstalledSkills } from "@/lib/skills";

export const runtime = "nodejs";

export async function GET() {
  const skills = await listInstalledSkills();
  return Response.json({ skills });
}
