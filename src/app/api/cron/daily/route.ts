import { NextResponse } from "next/server";
import { requestCheckRun } from "@/lib/checker";
import { getEnv } from "@/lib/env";

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${getEnv().CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await requestCheckRun("cron");
  return NextResponse.json(result, { status: result.accepted ? 202 : 409 });
}
