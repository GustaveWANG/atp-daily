import styles from "@/styles/MiniPlayer.module.css";

// Formate des secondes en M:SS
function fmt(secs: number): string {
  if (!isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface MiniPlayerProps {
  visible: boolean;
  title: string;
  playing: boolean;
  currentTime: number;
  duration: number;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
}

export default function MiniPlayer({
  visible,
  title,
  playing,
  currentTime,
  duration,
  onPlayPause,
  onSeek,
}: MiniPlayerProps) {
  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  // Calcule la position de recherche à partir du clic sur la barre de progression
  function handleProgressClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(frac * duration);
  }

  return (
    <div
      className={`${styles.miniPlayer} ${visible ? styles.miniPlayerVisible : ""}`}
      role="region"
      aria-label="Mini player"
    >
      {/* Barre de progression en haut — cliquable */}
      <div
        className={styles.miniProgress}
        onClick={handleProgressClick}
        role="slider"
        aria-label="Seek"
        aria-valuenow={Math.round(currentTime)}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
      >
        <div className={styles.miniProgressFill} style={{ width: `${pct}%` }} />
      </div>

      <div className={styles.miniBody}>
        {/* Vignette de l'épisode */}
        <div className={styles.miniThumb} aria-hidden="true">tennis</div>

        {/* Titre et temps */}
        <div className={styles.miniInfo}>
          <div className={styles.miniTitle}>{title}</div>
          <div className={styles.miniTimes}>
            <span>{fmt(currentTime)}</span>
            <span>{duration > 0 ? fmt(duration) : "--:--"}</span>
          </div>
        </div>

        {/* Bouton play/pause */}
        <button
          className={styles.miniPlayBtn}
          onClick={onPlayPause}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? "❚❚" : "▶"}
        </button>
      </div>
    </div>
  );
}
