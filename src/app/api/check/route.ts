import { NextResponse } from "next/server";
import {
  getCheckWorkflowHttpStatus,
  requestAndStartCheckWorkflow,
} from "@/lib/check-workflow";
import { isAdminRequestAuthorized } from "@/lib/auth";

export async function POST(request: Request) {
  if (!(await isAdminRequestAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await requestAndStartCheckWorkflow({ triggerSource: "manual" });

  return NextResponse.json(result, { status: getCheckWorkflowHttpStatus(result) });
}
