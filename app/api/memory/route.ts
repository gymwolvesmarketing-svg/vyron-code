import { NextRequest, NextResponse } from "next/server";

// Same status as /api/project-state — see that route's comment. Stubbed pending the
// separately-authorized `vyron_code` Bridge client identity.
export async function GET(req: NextRequest) {
  const projectId = new URL(req.url).searchParams.get("project_id");
  if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 });

  return NextResponse.json(
    {
      status: "not_yet_authorized",
      message:
        "Scoped memory read requires the 'vyron_code' Bridge client identity, which has not been created " +
        "(pending separate explicit authorization per the Acceptance Criteria doc). Returning a stub.",
      memory: null,
    },
    { status: 501 }
  );
}
