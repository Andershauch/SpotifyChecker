import { NextResponse } from "next/server";
import { requestCheckRun } from "@/lib/checker";
import { isAdminRequestAuthorized } from "@/lib/auth";

export async function POST(request: Request) {
  if (!(await isAdminRequestAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await requestCheckRun("manual", {
    playlistLimit: 5,
    ignoreCheckpoints: true,
  });

  return NextResponse.json(result, { status: result.accepted ? 202 : 409 });
}
