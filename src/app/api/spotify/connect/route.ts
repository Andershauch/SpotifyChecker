import { NextResponse } from "next/server";
import { createSpotifyAuthorizationUrl } from "@/lib/spotify";

export async function POST() {
  const url = await createSpotifyAuthorizationUrl();
  return NextResponse.json({ url });
}
