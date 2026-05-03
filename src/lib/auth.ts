import { createHmac, timingSafeEqual } from "node:crypto";
import { getSpotifySessionState } from "@/lib/db";
import { getEnv } from "@/lib/env";

const ADMIN_SESSION_COOKIE_NAME = "spotifycheck_admin_session";
const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

type AdminSessionPayload = {
  spotifyUserId: string;
  exp: number;
};

export function getAdminSessionCookieName() {
  return ADMIN_SESSION_COOKIE_NAME;
}

export function createAdminSessionCookieValue(spotifyUserId: string) {
  const payload: AdminSessionPayload = {
    spotifyUserId,
    exp: Math.floor(Date.now() / 1000) + ADMIN_SESSION_MAX_AGE_SECONDS,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export async function isAdminRequestAuthorized(request: Request) {
  // The admin UI is a single-user control panel. A valid signed cookie is only
  // accepted if it still matches the Spotify user stored in the current session.
  const cookieValue = getCookieValue(
    request.headers.get("cookie"),
    ADMIN_SESSION_COOKIE_NAME,
  );

  if (!cookieValue) {
    return false;
  }

  const payload = verifyAdminSessionCookieValue(cookieValue);
  if (!payload) {
    return false;
  }

  const spotifySession = await getSpotifySessionState();
  if (!spotifySession) {
    return false;
  }

  return spotifySession.spotifyUserId === payload.spotifyUserId;
}

function verifyAdminSessionCookieValue(cookieValue: string) {
  const [encodedPayload, signature] = cookieValue.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = sign(encodedPayload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as AdminSessionPayload;

    if (
      typeof payload.spotifyUserId !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function sign(value: string) {
  return createHmac("sha256", getEnv().CRON_SECRET).update(value).digest("base64url");
}

function getCookieValue(cookieHeader: string | null, name: string) {
  if (!cookieHeader) {
    return null;
  }

  const parts = cookieHeader.split(";").map((part) => part.trim());
  for (const part of parts) {
    if (!part.startsWith(`${name}=`)) {
      continue;
    }

    return decodeURIComponent(part.slice(name.length + 1));
  }

  return null;
}

export const adminSessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: getEnv().NODE_ENV === "production",
  path: "/",
  maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
};
