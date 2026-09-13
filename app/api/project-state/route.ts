import { NextRequest, NextResponse } from "next/server";

// Stubbed until the `vyron_code` Bridge client identity is separately authorized and
// created (see VYRON_CODE_V01_ACCEPTANCE_CRITERIA.md — this is explicitly NOT authorized
// by the general implementation go-ahead). The response shape below is the documented
// target shape from VYRON_CODE_V01_API_AND_DATA_MODEL.md so the frontend can be built
// against it now; swap the body for a real fetch to Bridge's
// GET /v1/context/project-state once the identity exists, no signature change needed.
export async function GET(req: NextRequest) {
  const projectId = new URL(req.url).searchParams.get("project_id");
  if (!projectId) return NextResponse.json({ error: "project_id required" }, { status: 400 });

  return NextResponse.json(
    {
      status: "not_yet_authorized",
      message:
        "PROJECT_STATE read requires the 'vyron_code' Bridge client identity, which has not been created " +
        "(pending separate explicit authorization per the Acceptance Criteria doc). Returning a stub.",
      project_state: null,
    },
    { status: 501 }
  );
}
