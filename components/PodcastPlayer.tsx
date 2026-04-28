import { useState, useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import styles from "@/styles/PodcastPlayer.module.css";

// Hauteurs des barres de la waveform (précalculées)
const WAVE_HEIGHTS = Array.from({ length: 48 }, (_, i) =>
  Math.max(4, 6 + Math.abs(Math.sin(i * 0.5)) * 28)
);

// Vitesses de lecture disponibles
const SPEEDS = [1, 1.25, 1.5, 2];

// Formate des secondes en M:SS
function fmt(secs: number): string {
  if (!isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export interface PlayerState {
  playing: boolean;
  currentTime: number;
  duration: number;
}

export interface PlayerHandle {
  togglePlayPause: () => void;
  seekTo: (time: number) => void;
}

interface PodcastPlayerProps {
  src: string;
  chapterTitles?: string[];
  fallbackDuration?: number;
  onStateChange?: (state: PlayerState) => void;
}

const PodcastPlayer = forwardRef<PlayerHandle, PodcastPlayerProps>(
  function PodcastPlayer({ src, chapterTitles = [], fallbackDuration, onStateChange }, ref) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const [playing, setPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [audioDuration, setAudioDuration] = useState(0);
    const [speed, setSpeed] = useState(1);
    const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);

    // Téléchargement préalable en blob → Object URL.
    // iOS Safari ne sait pas lire la durée d'un MP3 ElevenLabs streamé tant
    // que tout le fichier n'est pas connu, ce qui bloque la lecture à ~11s.
    // En fetchant la totalité avant lecture, on donne un fichier complet à
    // l'élément audio, qui peut alors seeker n'importe où.
    useEffect(() => {
      if (!src) return;
      let blobUrl: string | null = null;
      let cancelled = false;

      fetch(src)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.blob();
        })
        .then((blob) => {
          if (cancelled) return;
          blobUrl = URL.createObjectURL(blob);
          setResolvedSrc(blobUrl);
        })
        .catch(() => {
          // Si le fetch échoue (CORS, réseau), on retombe sur l'URL directe
          if (!cancelled) setResolvedSrc(src);
        });

      return () => {
        cancelled = true;
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      };
    }, [src]);

    // Durée effective : on privilégie celle de l'élément audio si elle paraît
    // crédible (≥ fallback − 2s pour absorber les petites imprécisions), sinon
    // on retombe sur la valeur DB. Évite la barre bloquée à 11s sur iOS Safari
    // tant que les métadonnées MP3 ne sont pas complètement chargées.
    const fb = fallbackDuration ?? 0;
    const duration = audioDuration > 0 && audioDuration >= fb - 2 ? audioDuration : fb;

    // Notifie le parent à chaque changement d'état de lecture
    useEffect(() => {
      onStateChange?.({ playing, currentTime, duration });
    }, [playing, currentTime, duration]); // eslint-disable-line react-hooks/exhaustive-deps

    // Applique la vitesse de lecture à l'élément audio
    useEffect(() => {
      if (audioRef.current) audioRef.current.playbackRate = speed;
    }, [speed]);

    useImperativeHandle(ref, () => ({
      togglePlayPause() {
        const audio = audioRef.current;
        if (!audio) return;
        if (playing) audio.pause();
        else void audio.play();
      },
      seekTo(time: number) {
        const audio = audioRef.current;
        if (!audio) return;
        audio.currentTime = Math.max(0, Math.min(time, audio.duration || 0));
      },
    }));

    function togglePlayPause() {
      const audio = audioRef.current;
      if (!audio) return;
      if (playing) audio.pause();
      else void audio.play();
    }

    function skip(delta: number) {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = Math.max(0, Math.min(audio.currentTime + delta, audio.duration || 0));
    }

    function cycleSpeed() {
      setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]);
    }

    // Cherche la position correspondant au clic sur la waveform
    function handleWaveClick(e: React.MouseEvent<HTMLDivElement>) {
      if (!duration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const audio = audioRef.current;
      if (audio) audio.currentTime = frac * duration;
    }

    // Saute au début du chapitre sélectionné
    function seekToChapter(index: number) {
      if (!duration || !chapterTitles.length) return;
      const time = (index / chapterTitles.length) * duration;
      const audio = audioRef.current;
      if (audio) audio.currentTime = time;
    }

    // Chapitre actif basé sur la position actuelle dans la durée
    const activeCh =
      chapterTitles.length > 0 && duration > 0
        ? Math.min(
            chapterTitles.length - 1,
            Math.floor((currentTime / duration) * chapterTitles.length)
          )
        : -1;

    const playedFrac = duration > 0 ? currentTime / duration : 0;

    return (
      <div className={styles.player}>
        {/* Élément audio caché — alimenté par un Object URL (blob téléchargé
            en amont) pour que la durée et le seek fonctionnent correctement
            sur iOS Safari, même quand le MP3 ElevenLabs n'a pas de Xing
            header. Tant que le blob n'est pas prêt, src reste vide. */}
        <audio
          ref={audioRef}
          src={resolvedSrc ?? undefined}
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (isFinite(d) && d > 0) setAudioDuration(d);
          }}
          onDurationChange={(e) => {
            const d = e.currentTarget.duration;
            if (isFinite(d) && d > 0) setAudioDuration(d);
          }}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        />

        {/* Waveform cliquable — sert de barre de progression */}
        <div
          className={styles.wave}
          onClick={handleWaveClick}
          role="slider"
          aria-label="Seek audio"
          aria-valuenow={Math.round(currentTime)}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
        >
          {WAVE_HEIGHTS.map((h, i) => (
            <div
              key={i}
              className={`${styles.waveBar} ${
                i / WAVE_HEIGHTS.length < playedFrac ? styles.waveBarPlayed : ""
              }`}
              style={{ height: h }}
            />
          ))}
        </div>

        {/* Temps écoulé / durée totale */}
        <div className={styles.times}>
          <span>{fmt(currentTime)}</span>
          <span>{duration > 0 ? fmt(duration) : "--:--"}</span>
        </div>

        {/* Contrôles : rewind 15s — play/pause — forward 30s — vitesse */}
        <div className={styles.controls}>
          <button
            className={styles.skipBtn}
            onClick={() => skip(-15)}
            aria-label="Rewind 15 seconds"
          >
            <span className={styles.skipIcon}>↺</span>
            <span className={styles.skipLabel}>15</span>
          </button>

          <button
            className={styles.playBtn}
            onClick={togglePlayPause}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? "❚❚" : "▶"}
          </button>

          <button
            className={styles.skipBtn}
            onClick={() => skip(30)}
            aria-label="Forward 30 seconds"
          >
            <span className={styles.skipIcon}>↻</span>
            <span className={styles.skipLabel}>30</span>
          </button>

          <button
            className={styles.speedBtn}
            onClick={cycleSpeed}
            aria-label={`Playback speed: ${speed}x`}
          >
            {speed === 1 ? "1×" : `${speed}×`}
          </button>
        </div>

        {/* Chapitres — visibles dès que la durée est chargée */}
        {duration > 0 && chapterTitles.length > 0 && (
          <div className={styles.chapters}>
            {chapterTitles.map((title, i) => (
              <button
                key={i}
                className={`${styles.chapterChip} ${
                  i === activeCh ? styles.chapterChipActive : ""
                }`}
                onClick={() => seekToChapter(i)}
              >
                <span className={styles.chapterTime}>
                  {fmt((i / chapterTitles.length) * duration)}
                </span>
                <span className={styles.chapterName}>{title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
);

PodcastPlayer.displayName = "PodcastPlayer";
export default PodcastPlayer;
