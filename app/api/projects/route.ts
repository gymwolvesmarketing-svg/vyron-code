import { NextRequest, NextResponse } from "next/server";
import { addProject, listProjects } from "@/lib/projects";

export async function GET() {
  return NextResponse.json({ projects: listProjects() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const rawPath = body?.path;
  if (!rawPath || typeof rawPath !== "string") {
    return NextResponse.json({ error: "path (string) required" }, { status: 400 });
  }
  const result = addProject(rawPath, typeof body?.display_name === "string" ? body.display_name : undefined);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 400 });
  }
  return NextResponse.json({ project: result.project });
}
