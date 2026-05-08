import { NextResponse } from "next/server";
import {
  getCheckWorkflowHttpStatus,
  requestAndStartCheckWorkflow,
} from "@/lib/check-workflow";
import { getEnv } from "@/lib/env";

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${getEnv().CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await requestAndStartCheckWorkflow({ triggerSource: "cron" });

  return NextResponse.json(result, { status: getCheckWorkflowHttpStatus(result) });
}
