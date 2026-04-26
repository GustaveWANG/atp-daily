import type { NextApiRequest, NextApiResponse } from "next";

// Limite de taille de réponse augmentée pour l'audio MP3
export const config = { api: { responseLimit: "10mb" } };

const ELEVENLABS_API = "https://api.elevenlabs.io/v1/text-to-speech";

// Audio de démo utilisé quand la clé ElevenLabs n'est pas configurée
const FALLBACK_AUDIO_URL =
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3";

// Voix par défaut : Bella pour Alex, Antoni pour Sam
const VOICE_ALEX =
  process.env.ELEVENLABS_VOICE_ALEX ?? "EXAVITQu4vr4xnSDxMaL";
const VOICE_SAM =
  process.env.ELEVENLABS_VOICE_SAM ?? "ErXwobaYiN019PkySvjV";

type Segment = { speaker: "ALEX" | "SAM"; text: string };

// Découpe le script en segments par locuteur, en ignorant les lignes vides
function parseSegments(script: string): Segment[] {
  return script
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line): Segment[] => {
      if (line.startsWith("ALEX:")) {
        return [{ speaker: "ALEX", text: line.slice(5).trim() }];
      }
      if (line.startsWith("SAM:")) {
        return [{ speaker: "SAM", text: line.slice(4).trim() }];
      }
      return [];
    });
}

// Appelle l'API ElevenLabs et retourne le buffer MP3
async function synthesize(text: string, voiceId: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const res = await fetch(`${ELEVENLABS_API}/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`ElevenLabs ${res.status}: ${msg}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Fallback sans clé ElevenLabs — renvoie l'URL d'un MP3 de démo
  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(200).json({ fallbackUrl: FALLBACK_AUDIO_URL });
  }

  const { script } = req.body as { script?: string };
  if (!script || typeof script !== "string" || script.trim().length === 0) {
    return res.status(400).json({ error: "Missing or empty script" });
  }

  const segments = parseSegments(script);
  if (segments.length === 0) {
    return res.status(400).json({ error: "No speakable lines found in script" });
  }

  try {
    // Appels TTS séquentiels pour respecter la limite de requêtes simultanées du free tier
    const buffers: Buffer[] = [];
    for (const seg of segments) {
      const voiceId = seg.speaker === "ALEX" ? VOICE_ALEX : VOICE_SAM;
      buffers.push(await synthesize(seg.text, voiceId));
    }

    const combined = Buffer.concat(buffers);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", combined.length);
    res.send(combined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: msg });
  }
}
