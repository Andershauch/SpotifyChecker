import { NextResponse } from "next/server";
import { runSpotifySmokeCheck } from "@/lib/checker";
import { isAdminRequestAuthorized } from "@/lib/auth";

export async function POST(request: Request) {
  if (!(await isAdminRequestAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runSpotifySmokeCheck();
  const status = result.status === "error" ? 500 : 200;
  return NextResponse.json(result, { status });
}
