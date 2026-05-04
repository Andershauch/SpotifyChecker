import { NextResponse } from "next/server";
import { requestCheckRun } from "@/lib/checker";
import { failWorkflowKickoff, startCheckWorkflowRun } from "@/lib/check-workflow";
import { isAdminRequestAuthorized } from "@/lib/auth";

export async function POST(request: Request) {
  if (!(await isAdminRequestAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await requestCheckRun("manual");

  if (result.accepted && result.jobId) {
    try {
      await startCheckWorkflowRun({
        jobId: result.jobId,
        triggerSource: "manual",
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? `Workflow kunne ikke startes: ${error.message}`
          : "Workflow kunne ikke startes.";
      await failWorkflowKickoff(result.jobId, message);
      return NextResponse.json(
        { accepted: false, jobId: result.jobId, status: "workflow_failed", errorMessage: message },
        { status: 500 },
      );
    }
  }

  return NextResponse.json(result, { status: result.accepted ? 202 : 409 });
}
