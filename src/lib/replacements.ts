import { z } from "zod";
import { getEnv } from "@/lib/env";
import {
  getUnavailableTrack,
  replaceTrackReplacements,
  upsertTrackReplacement,
  type CurrentUnavailableTrackRow,
} from "@/lib/db";
import { fetchTrackSuggestionContext, searchTrackOnSpotify } from "@/lib/spotify";

const suggestionSchema = z.object({
  suggestedTrackName: z.string().min(1),
  suggestedArtistName: z.string().min(1),
  suggestedSpotifyUrl: z.string().url().nullable(),
  suggestedSpotifyTrackId: z.string().min(1).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  estimatedBpm: z.number().int().nonnegative().nullable(),
});

const replacementResponseSchema = z.object({
  referenceArtistName: z.string().min(1).nullable(),
  referenceEstimatedBpm: z.number().int().nonnegative().nullable(),
  suggestions: z.array(suggestionSchema).length(2),
});

export type TrackReplacementSuggestion = z.infer<typeof suggestionSchema>;

export async function generateAndStoreTrackReplacements(input: {
  playlistId: string;
  trackId: string;
}) {
  const unavailableTrack = await getUnavailableTrack(input.playlistId, input.trackId);
  if (!unavailableTrack) {
    throw new Error("Det utilgængelige track blev ikke fundet i databasen.");
  }

  const trackContext = await fetchTrackSuggestionContext(input.trackId);
  const directTitleMatch = await searchTrackOnSpotify({
    trackName: trackContext.trackName || unavailableTrack.track_name,
    artistName: trackContext.artistNames[0] ?? null,
    durationMs: trackContext.durationMs ?? unavailableTrack.duration_ms,
    excludeTrackId: input.trackId,
    requireExactTitle: true,
    maxDurationDifferenceMs: 60_000,
    allowVersionTitleMatch: true,
    limit: 10,
    useBroadFallback: true,
  });
  const directTitleSuggestion = directTitleMatch
    ? {
        suggestedTrackName: directTitleMatch.trackName,
        suggestedArtistName: directTitleMatch.artistName ?? "Ukendt kunstner",
        suggestedSpotifyUrl: directTitleMatch.spotifyUrl,
        suggestedSpotifyTrackId: directTitleMatch.trackId,
        durationMs: directTitleMatch.durationMs,
        estimatedBpm: null,
        reasoningSummary: "spotify-title-duration-match",
      }
    : null;
  if (directTitleSuggestion) {
    await upsertTrackReplacement({
      playlistId: input.playlistId,
      unavailableTrackId: input.trackId,
      referenceArtistName: null,
      referenceEstimatedBpm: null,
      sourceModel: getEnv().OPENAI_SUGGESTION_MODEL,
      suggestionIndex: 0,
      ...directTitleSuggestion,
    });
  }

  let suggestionResult: z.infer<typeof replacementResponseSchema>;
  try {
    suggestionResult = await generateTrackReplacementSuggestions({
      unavailableTrack,
      trackContext,
    });
  } catch (error) {
    if (directTitleSuggestion) {
      return {
        referenceArtistName: null,
        referenceEstimatedBpm: null,
        suggestions: [directTitleSuggestion],
      };
    }

    throw error;
  }
  const hydratedSuggestions = await Promise.all(
    suggestionResult.suggestions.map(async (suggestion) => {
      const spotifyMatch =
        suggestion.suggestedSpotifyUrl && suggestion.suggestedSpotifyTrackId
          ? null
          : await searchTrackOnSpotify({
              trackName: suggestion.suggestedTrackName,
              artistName: suggestion.suggestedArtistName,
              durationMs: suggestion.durationMs,
            });

      return {
        ...suggestion,
        suggestedSpotifyUrl: suggestion.suggestedSpotifyUrl ?? spotifyMatch?.spotifyUrl ?? null,
        suggestedSpotifyTrackId:
          suggestion.suggestedSpotifyTrackId ?? spotifyMatch?.trackId ?? null,
        durationMs: suggestion.durationMs ?? spotifyMatch?.durationMs ?? null,
      };
    }),
  );
  const suggestionsToStore = [
    ...(directTitleSuggestion ? [directTitleSuggestion] : []),
    ...hydratedSuggestions
      .filter((suggestion) => suggestion.suggestedSpotifyTrackId !== directTitleMatch?.trackId)
      .map((suggestion) => ({
        ...suggestion,
        reasoningSummary: "format-only",
      })),
  ];

  await replaceTrackReplacements({
    playlistId: input.playlistId,
    unavailableTrackId: input.trackId,
    referenceArtistName: suggestionResult.referenceArtistName,
    referenceEstimatedBpm: suggestionResult.referenceEstimatedBpm,
    sourceModel: getEnv().OPENAI_SUGGESTION_MODEL,
    suggestions: suggestionsToStore.map((suggestion, index) => ({
      suggestionIndex: index + 1,
      suggestedTrackName: suggestion.suggestedTrackName,
      suggestedArtistName: suggestion.suggestedArtistName,
      suggestedSpotifyUrl: suggestion.suggestedSpotifyUrl,
      suggestedSpotifyTrackId:
        suggestion.suggestedSpotifyTrackId ?? extractSpotifyTrackId(suggestion.suggestedSpotifyUrl),
      durationMs: suggestion.durationMs,
      estimatedBpm: suggestion.estimatedBpm,
      reasoningSummary: suggestion.reasoningSummary,
    })),
  });

  return {
    ...suggestionResult,
    suggestions: suggestionsToStore,
  };
}

async function generateTrackReplacementSuggestions(input: {
  unavailableTrack: CurrentUnavailableTrackRow;
  trackContext: {
    trackId: string;
    trackName: string;
    artistNames: string[];
    durationMs: number | null;
    spotifyUrl: string | null;
  };
}): Promise<z.infer<typeof replacementResponseSchema>> {
  const apiKey = getEnv().OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY mangler. Sæt den før du genererer erstatningsforslag.");
  }

  const promptPayload = {
    playlistName: input.unavailableTrack.playlist_name,
    unavailableTrack: {
      trackId: input.unavailableTrack.track_id,
      trackName: input.trackContext.trackName || input.unavailableTrack.track_name,
      artistNames: input.trackContext.artistNames,
      durationMs: input.trackContext.durationMs ?? input.unavailableTrack.duration_ms,
      spotifyUrl: input.trackContext.spotifyUrl,
    },
    goal: {
      numberOfSuggestions: 2,
      preferSpotifyLinks: true,
      keepSimilarDuration: true,
      durationToleranceMs: 1_000,
      includeEstimatedBpm: true,
      avoidExactSameTrack: true,
    },
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: getEnv().OPENAI_SUGGESTION_MODEL,
      instructions:
        "Du hjælper med musik-curation. Når du får et Spotify-track, skal du identificere titel, kunstner, " +
        "version/remix/edit hvis det fremgår, ca. længde og et kvalificeret BPM-estimat. " +
        "Returnér derefter præcis 2 konkrete alternativer, som matcher samme stil og samme tempo/BPM. " +
        "De 2 alternativer skal være inden for plus/minus 1 sekund af originalens længde, hvis originalens længde er kendt. " +
        "Hvis du ikke kan finde et forslag inden for den tolerance, så vælg det tætteste realistiske Spotify-track og angiv dets bedste kendte længde. " +
        "Ingen begrundelser, ingen ekstra forklaring, kun struktureret data. " +
        "Returnér kun forslag, som sandsynligvis findes på Spotify, og undgå det originale track.",
      input: JSON.stringify(promptPayload),
      text: {
        format: {
          type: "json_schema",
          name: "track_replacement_suggestions",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              referenceArtistName: {
                type: ["string", "null"],
              },
              referenceEstimatedBpm: {
                type: ["integer", "null"],
              },
              suggestions: {
                type: "array",
                minItems: 2,
                maxItems: 2,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    suggestedTrackName: { type: "string" },
                    suggestedArtistName: { type: "string" },
                    suggestedSpotifyUrl: { type: ["string", "null"] },
                    suggestedSpotifyTrackId: { type: ["string", "null"] },
                    durationMs: { type: ["integer", "null"] },
                    estimatedBpm: { type: ["integer", "null"] },
                  },
                  required: [
                    "suggestedTrackName",
                    "suggestedArtistName",
                    "suggestedSpotifyUrl",
                    "suggestedSpotifyTrackId",
                    "durationMs",
                    "estimatedBpm",
                  ],
                },
              },
            },
            required: ["referenceArtistName", "referenceEstimatedBpm", "suggestions"],
          },
        },
      },
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `OpenAI suggestion request failed: ${response.status}${message ? ` ${message}` : ""}`,
    );
  }

  const payload = (await response.json()) as {
    output?: Array<{
      type?: string;
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    }>;
  };

  const text = extractOutputText(payload);
  if (!text) {
    throw new Error("OpenAI returnerede ikke noget JSON-output til erstatningsforslag.");
  }

  const parsed = replacementResponseSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`OpenAI output matchede ikke schemaet: ${parsed.error.message}`);
  }

  return parsed.data;
}

function extractOutputText(payload: {
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}) {
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }

  return null;
}

function extractSpotifyTrackId(url: string | null) {
  if (!url) {
    return null;
  }

  const match = url.match(/track\/([a-zA-Z0-9]+)/);
  return match?.[1] ?? null;
}
