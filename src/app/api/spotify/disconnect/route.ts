import { NextResponse } from "next/server";
import { disconnectSpotifySession } from "@/lib/spotify";
import {
  adminSessionCookieOptions,
  getAdminSessionCookieName,
  isAdminRequestAuthorized,
} from "@/lib/auth";

export async function POST(request: Request) {
  if (!(await isAdminRequestAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await disconnectSpotifySession();
  const response = NextResponse.json({ disconnected: true });
  response.cookies.set(getAdminSessionCookieName(), "", {
    ...adminSessionCookieOptions,
    maxAge: 0,
  });
  return response;
}
