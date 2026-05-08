import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminRequestAuthorized } from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { generateAndStoreTrackReplacements } from "@/lib/replacements";

const requestSchema = z.object({
  playlistId: z.string().min(1),
  trackId: z.string().min(1),
});

export async function POST(request: Request) {
  if (!(await isAdminRequestAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureSchema();

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body mangler eller er ugyldig JSON." }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "playlistId og trackId er påkrævet." }, { status: 400 });
  }

  try {
    const suggestions = await generateAndStoreTrackReplacements(parsed.data);
    return NextResponse.json({ suggestions });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Kunne ikke generere erstatningsforslag.";

    return NextResponse.json(
      {
        error: message,
      },
      { status: message.includes("OpenAI brugte mere end") ? 504 : 500 },
    );
  }
}
