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

// Trouve la position de tous les tags ID3v2 dans un buffer MP3. Chaque
// MP3 ElevenLabs commence par un ID3 ; quand le cron concatène plusieurs
// segments (un par locuteur), on se retrouve avec plusieurs ID3 successifs
// dans le même fichier. Safari (Web Audio API + <audio>) s'arrête à la
// première section, d'où une durée perçue de ~11 s.
function findId3Positions(view: Uint8Array): number[] {
  const positions: number[] = [];
  // Borne sûre : on a besoin de lire 4 octets (ID3 + version)
  for (let i = 0; i < view.length - 4; i++) {
    if (
      view[i] === 0x49 &&
      view[i + 1] === 0x44 &&
      view[i + 2] === 0x33 &&
      // Version ID3v2 : 2.0 / 3.0 / 4.0 — filtre les faux positifs
      view[i + 3] >= 0x02 &&
      view[i + 3] <= 0x04
    ) {
      positions.push(i);
    }
  }
  return positions;
}

// Décode un MP3 potentiellement constitué de plusieurs segments concaténés.
// Si un seul ID3 est trouvé → décodage direct. Sinon, chaque segment est
// décodé séparément puis les AudioBuffers sont concaténés.
async function decodeConcatenatedMp3(
  ab: ArrayBuffer,
  ctx: AudioContext
): Promise<AudioBuffer> {
  const view = new Uint8Array(ab);
  const positions = findId3Positions(view);

  // 0 ou 1 ID3 → fichier unique, on tente le décodage direct
  if (positions.length <= 1) {
    return ctx.decodeAudioData(ab.slice(0));
  }

  // Sinon, on découpe entre chaque ID3
  const slices: ArrayBuffer[] = [];
  for (let p = 0; p < positions.length; p++) {
    const start = positions[p];
    const end = p + 1 < positions.length ? positions[p + 1] : view.length;
    slices.push(ab.slice(start, end));
  }

  const buffers: AudioBuffer[] = [];
  for (const slice of slices) {
    try {
      const buf = await ctx.decodeAudioData(slice);
      buffers.push(buf);
    } catch (err) {
      console.warn("[PodcastPlayer] segment decode failed:", err);
    }
  }

  if (buffers.length === 0) {
    // Dernier recours : décodage direct
    return ctx.decodeAudioData(ab.slice(0));
  }

  // Concaténation des AudioBuffers en un seul, pour pouvoir seek partout
  const sampleRate = buffers[0].sampleRate;
  const numChannels = Math.max(...buffers.map((b) => b.numberOfChannels));
  const totalLength = buffers.reduce((sum, b) => sum + b.length, 0);
  const result = ctx.createBuffer(numChannels, totalLength, sampleRate);

  let offset = 0;
  for (const b of buffers) {
    for (let ch = 0; ch < numChannels; ch++) {
      const target = result.getChannelData(ch);
      const source = b.getChannelData(Math.min(ch, b.numberOfChannels - 1));
      target.set(source, offset);
    }
    offset += b.length;
  }
  return result;
}

// On utilise Web Audio API (et pas <audio>) parce que les MP3 ElevenLabs
// concaténés n'ont pas de header Xing/LAME : iOS Safari y voit alors une
// durée bogus (~11 s) et clampe `audio.currentTime` à cette valeur, ce qui
// rend tout seek réel impossible. En décodant le buffer complet et en
// jouant avec un AudioBufferSourceNode, on contourne entièrement ce bug.
const PodcastPlayer = forwardRef<PlayerHandle, PodcastPlayerProps>(
  function PodcastPlayer({ src, chapterTitles = [], fallbackDuration, onStateChange }, ref) {
    const ctxRef = useRef<AudioContext | null>(null);
    const bufferRef = useRef<AudioBuffer | null>(null);
    const sourceRef = useRef<AudioBufferSourceNode | null>(null);
    // Ancre : { ctxTime: ctx.currentTime au démarrage du source courant,
    //           offset: position dans le buffer à ce moment-là }
    const anchorRef = useRef<{ ctxTime: number; offset: number } | null>(null);
    // Position sauvée à la pause / au seek hors lecture
    const pausedAtRef = useRef(0);
    // Sentinelle pour distinguer une fin naturelle d'un stop manuel
    const stopReasonRef = useRef<"manual" | "natural">("manual");

    const [decodedDuration, setDecodedDuration] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [speed, setSpeed] = useState(1);

    // On préfère la durée décodée (exacte), sinon le fallback DB
    const fb = fallbackDuration ?? 0;
    const duration = decodedDuration > 0 ? decodedDuration : fb;

    // Notifie le parent à chaque changement d'état
    useEffect(() => {
      onStateChange?.({ playing, currentTime, duration });
    }, [playing, currentTime, duration]); // eslint-disable-line react-hooks/exhaustive-deps

    // Initialise l'AudioContext + télécharge & décode le MP3
    useEffect(() => {
      if (!src) return;
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctor();
      ctxRef.current = ctx;

      let cancelled = false;
      fetch(src)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((ab) => decodeConcatenatedMp3(ab, ctx))
        .then((buf) => {
          if (cancelled) return;
          bufferRef.current = buf;
          setDecodedDuration(buf.duration);
        })
        .catch((err) => {
          // En cas d'échec, l'UI continue sur fallbackDuration mais le seek
          // ne marchera pas — on log pour faciliter le debug.
          console.error("[PodcastPlayer] decodeAudioData failed:", err);
        });

      return () => {
        cancelled = true;
        const s = sourceRef.current;
        if (s) {
          stopReasonRef.current = "manual";
          try {
            s.stop();
          } catch {
            /* déjà stoppé */
          }
          s.disconnect();
        }
        sourceRef.current = null;
        anchorRef.current = null;
        ctx.close().catch(() => {});
        ctxRef.current = null;
        bufferRef.current = null;
      };
    }, [src]);

    // Boucle d'animation : tant qu'on joue, on calcule la position via
    // ctx.currentTime - ancre, multiplié par la vitesse de lecture.
    useEffect(() => {
      if (!playing) return;
      let raf = 0;
      const tick = () => {
        const ctx = ctxRef.current;
        const buf = bufferRef.current;
        const a = anchorRef.current;
        if (ctx && buf && a) {
          const elapsed = (ctx.currentTime - a.ctxTime) * speed;
          const t = a.offset + elapsed;
          if (t >= buf.duration) {
            setCurrentTime(buf.duration);
            return; // la fin sera gérée par node.onended
          }
          setCurrentTime(t);
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, [playing, speed]);

    // Démarre un nouveau source au offset donné. Stoppe l'ancien sans
    // déclencher la logique de fin naturelle.
    function startSourceAt(offset: number) {
      const ctx = ctxRef.current;
      const buf = bufferRef.current;
      if (!ctx || !buf) return;

      const old = sourceRef.current;
      if (old) {
        stopReasonRef.current = "manual";
        try {
          old.stop();
        } catch {
          /* ok */
        }
        old.disconnect();
      }

      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.playbackRate.value = speed;
      node.connect(ctx.destination);
      node.onended = () => {
        // Filtre les onended provoqués par un stop() manuel (seek/pause)
        if (stopReasonRef.current === "manual") {
          stopReasonRef.current = "manual";
          return;
        }
        if (sourceRef.current !== node) return;
        sourceRef.current = null;
        anchorRef.current = null;
        pausedAtRef.current = buf.duration;
        setCurrentTime(buf.duration);
        setPlaying(false);
      };
      stopReasonRef.current = "natural";
      node.start(0, offset);
      sourceRef.current = node;
      anchorRef.current = { ctxTime: ctx.currentTime, offset };
    }

    function play() {
      const ctx = ctxRef.current;
      const buf = bufferRef.current;
      if (!ctx || !buf) return;
      // iOS exige resume() depuis un geste utilisateur (le clic play()
      // est bien un geste utilisateur, donc OK).
      void ctx.resume();
      const start =
        pausedAtRef.current >= buf.duration - 0.05 ? 0 : pausedAtRef.current;
      pausedAtRef.current = start;
      setCurrentTime(start);
      startSourceAt(start);
      setPlaying(true);
    }

    function pause() {
      const ctx = ctxRef.current;
      const node = sourceRef.current;
      const a = anchorRef.current;
      if (!ctx || !node || !a) {
        setPlaying(false);
        return;
      }
      const elapsed = (ctx.currentTime - a.ctxTime) * speed;
      const pos = Math.max(0, Math.min(a.offset + elapsed, decodedDuration));
      pausedAtRef.current = pos;
      stopReasonRef.current = "manual";
      try {
        node.stop();
      } catch {
        /* ok */
      }
      node.disconnect();
      sourceRef.current = null;
      anchorRef.current = null;
      setCurrentTime(pos);
      setPlaying(false);
    }

    function togglePlayPause() {
      if (playing) pause();
      else play();
    }

    // Seek borné à la durée décodée (ou fallback si pas encore décodé).
    function safeSeek(targetTime: number) {
      const buf = bufferRef.current;
      const max = buf
        ? buf.duration - 0.05
        : duration > 0
          ? duration
          : Number.POSITIVE_INFINITY;
      const t = Math.max(0, Math.min(targetTime, max));
      pausedAtRef.current = t;
      setCurrentTime(t);
      if (playing && buf) {
        startSourceAt(t);
      }
    }

    function skip(delta: number) {
      safeSeek(currentTime + delta);
    }

    function cycleSpeed() {
      const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
      const ctx = ctxRef.current;
      const node = sourceRef.current;
      const a = anchorRef.current;
      // En lecture : on applique le nouveau playbackRate au source courant
      // et on réancre, sans avoir à recréer un node.
      if (playing && ctx && node && a) {
        const elapsed = (ctx.currentTime - a.ctxTime) * speed;
        const pos = a.offset + elapsed;
        node.playbackRate.value = next;
        anchorRef.current = { ctxTime: ctx.currentTime, offset: pos };
      }
      setSpeed(next);
    }

    // Calcule la position cible à partir d'un clientX et de l'élément cible
    function timeFromClientX(el: HTMLElement, clientX: number): number {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return 0;
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return frac * duration;
    }

    // Pointer (souris + tactile) sur la waveform : tap simple OU drag continu.
    function handleWavePointerDown(e: React.PointerEvent<HTMLDivElement>) {
      if (!duration) return;
      const el = e.currentTarget;
      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* certains navigateurs refusent la capture sur pointer mouse */
      }
      safeSeek(timeFromClientX(el, e.clientX));

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        safeSeek(timeFromClientX(el, ev.clientX));
      };
      const cleanup = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", cleanup);
        el.removeEventListener("pointercancel", cleanup);
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", cleanup);
      el.addEventListener("pointercancel", cleanup);
    }

    function seekToChapter(index: number) {
      if (!duration || !chapterTitles.length) return;
      safeSeek((index / chapterTitles.length) * duration);
    }

    useImperativeHandle(ref, () => ({
      togglePlayPause,
      seekTo(time: number) {
        safeSeek(time);
      },
    }));

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
        {/* Waveform cliquable + draggable — sert de barre de progression. */}
        <div
          className={styles.wave}
          onPointerDown={handleWavePointerDown}
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
