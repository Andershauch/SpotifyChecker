import { NextResponse } from "next/server";
import { getCurrentCheckRunStatus, getLatestJobSnapshot } from "@/lib/checker";
import { isAdminRequestAuthorized } from "@/lib/auth";

export async function GET(request: Request) {
  if (!(await isAdminRequestAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [current, latestJob] = await Promise.all([
    getCurrentCheckRunStatus(),
    getLatestJobSnapshot(),
  ]);

  return NextResponse.json({ ...current, latestJob });
}
