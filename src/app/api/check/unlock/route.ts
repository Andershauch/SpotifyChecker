import { NextResponse } from "next/server";
import { forceUnlockCurrentCheckRun } from "@/lib/checker";
import { getEnv } from "@/lib/env";

export async function POST(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${getEnv().CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await forceUnlockCurrentCheckRun();
  return NextResponse.json(result);
}
