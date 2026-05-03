import { NextResponse } from "next/server";
import { requestCancelCurrentCheckRun } from "@/lib/checker";
import { isAdminRequestAuthorized } from "@/lib/auth";

export async function POST(request: Request) {
  if (!(await isAdminRequestAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await requestCancelCurrentCheckRun();
  return NextResponse.json(result);
}
