import { NextResponse } from "next/server";
import { completeSpotifyAuthorization } from "@/lib/spotify";
import {
  adminSessionCookieOptions,
  createAdminSessionCookieValue,
  getAdminSessionCookieName,
} from "@/lib/auth";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const error = searchParams.get("error");
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (error) {
    return NextResponse.redirect(
      `${origin}/?spotify=error&message=${encodeURIComponent(`Spotify afviste login: ${error}`)}`,
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      `${origin}/?spotify=error&message=${encodeURIComponent("Spotify callback manglede code eller state.")}`,
    );
  }

  try {
    const result = await completeSpotifyAuthorization({ code, state });
    const response = NextResponse.redirect(`${origin}/?spotify=connected`);
    response.cookies.set(
      getAdminSessionCookieName(),
      createAdminSessionCookieValue(result.spotifyUserId),
      adminSessionCookieOptions,
    );
    return response;
  } catch (callbackError) {
    const message =
      callbackError instanceof Error
        ? callbackError.message
        : "Spotify-login kunne ikke fuldføres.";

    return NextResponse.redirect(
      `${origin}/?spotify=error&message=${encodeURIComponent(message)}`,
    );
  }
}
