import type { NextApiRequest, NextApiResponse } from "next";

// Voix par défaut : Bella pour Alex, Antoni pour Sam
const VOICE_ALEX = process.env.ELEVENLABS_VOICE_ALEX ?? "EXAVITQu4vr4xnSDxMaL";
const VOICE_SAM = process.env.ELEVENLABS_VOICE_SAM ?? "ErXwobaYiN019PkySvjV";
const ELEVENLABS_API = "https://api.elevenlabs.io/v1/text-to-speech";
const STORAGE_BUCKET = "audio";

type Segment = { speaker: "ALEX" | "SAM"; text: string };

// Découpe le script en segments par locuteur
function parseSegments(script: string): Segment[] {
  return script
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line): Segment[] => {
      if (line.startsWith("ALEX:")) return [{ speaker: "ALEX", text: line.slice(5).trim() }];
      if (line.startsWith("SAM:")) return [{ speaker: "SAM", text: line.slice(4).trim() }];
      return [];
    });
}

// Appelle ElevenLabs et retourne le buffer MP3
async function synthesize(text: string, voiceId: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY!;
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

  return Buffer.from(await res.arrayBuffer());
}

// ElevenLabs génère du MP3 128 kbps → 16 000 octets par seconde
function estimateDuration(buffer: Buffer): number {
  return Math.round(buffer.length / 16000);
}

type CronResponse =
  | { ok: true; date: string; duration: number; audio_url: string }
  | { ok: true; skipped: true; reason: string }
  | { error: string };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CronResponse>
) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ?date=YYYY-MM-DD pour les tests manuels, sinon aujourd'hui (UTC)
  const date =
    typeof req.query.date === "string"
      ? req.query.date
      : new Date().toISOString().slice(0, 10);

  const { supabaseAdmin } = await import("@/lib/supabase-server");

  // Charger l'épisode existant — skip si script absent ou audio déjà généré
  const { data: episode, error: fetchError } = await supabaseAdmin
    .from("episodes")
    .select("script, audio_url")
    .eq("date", date)
    .single();

  if (fetchError || !episode) {
    return res.status(200).json({ ok: true, skipped: true, reason: "no episode found" });
  }

  if (!episode.script) {
    return res.status(200).json({ ok: true, skipped: true, reason: "no script yet" });
  }

  if (episode.audio_url) {
    return res.status(200).json({ ok: true, skipped: true, reason: "audio already exists" });
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(200).json({ ok: true, skipped: true, reason: "ELEVENLABS_API_KEY not configured" });
  }

  const segments = parseSegments(episode.script);
  if (segments.length === 0) {
    return res.status(200).json({ ok: true, skipped: true, reason: "no speakable segments in script" });
  }

  // Synthèse séquentielle pour respecter le free tier ElevenLabs
  const buffers: Buffer[] = [];
  try {
    for (const seg of segments) {
      const voiceId = seg.speaker === "ALEX" ? VOICE_ALEX : VOICE_SAM;
      buffers.push(await synthesize(seg.text, voiceId));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: `TTS synthesis failed: ${msg}` });
  }

  const combined = Buffer.concat(buffers);
  const duration = estimateDuration(combined);

  // Supabase Storage attend un Blob en environnement Node.js
  const blob = new Blob([combined], { type: "audio/mpeg" });

  // Upload dans Supabase Storage (bucket "audio", accès public requis)
  const storagePath = `episodes/${date}.mp3`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, blob, {
      contentType: "audio/mpeg",
      upsert: true,
    });

  if (uploadError) {
    return res.status(500).json({ error: `Storage upload failed: ${uploadError.message}` });
  }

  const { data: publicData } = supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(storagePath);

  const audioUrl = publicData.publicUrl;

  // Mise à jour de l'épisode avec l'URL audio et la durée
  const { error: updateError } = await supabaseAdmin
    .from("episodes")
    .update({ audio_url: audioUrl, audio_duration: duration })
    .eq("date", date);

  if (updateError) {
    return res.status(500).json({ error: `Episode update failed: ${updateError.message}` });
  }

  return res.status(200).json({ ok: true, date, duration, audio_url: audioUrl });
}
