import { useState, useEffect } from "react";
import styles from "@/styles/EpisodeFeedback.module.css";
import { listenerId } from "@/lib/listener";

// Retour rapide sous le lecteur : 👍/👎, puis un commentaire facultatif.
// L'étape atteinte est mémorisée par épisode pour ne pas redemander.

type Step = "ask" | "comment" | "done";

const storeKey = (date: string) => `atp-daily:feedback:${date}`;

function readStep(date: string): Step {
  try {
    const v = localStorage.getItem(storeKey(date));
    return v === "comment" || v === "done" ? v : "ask";
  } catch {
    return "ask";
  }
}

function saveStep(date: string, step: Step) {
  try {
    localStorage.setItem(storeKey(date), step);
  } catch {
    /* stockage bloqué : on redemandera à la prochaine visite */
  }
}

async function postFeedback(payload: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, listener_id: listenerId() }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default function EpisodeFeedback({ episodeDate }: { episodeDate: string }) {
  const [step, setStep] = useState<Step>("ask");
  const [liked, setLiked] = useState<boolean | null>(null);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  // localStorage n'existe qu'au client : lu après le montage
  useEffect(() => {
    setStep(readStep(episodeDate));
    setComment("");
    setFailed(false);
  }, [episodeDate]);

  function go(next: Step) {
    setStep(next);
    saveStep(episodeDate, next);
  }

  async function rate(rating: 1 | -1) {
    setLiked(rating === 1);
    go("comment");
    // Le vote part en arrière-plan : on ne bloque pas l'étape commentaire
    void postFeedback({ episode_date: episodeDate, rating });
  }

  async function sendComment(e: React.FormEvent) {
    e.preventDefault();
    if (!comment.trim()) return;
    setSending(true);
    setFailed(false);
    const ok = await postFeedback({ episode_date: episodeDate, comment });
    setSending(false);
    if (ok) go("done");
    else setFailed(true);
  }

  if (step === "done") {
    return <div className={styles.box}><p className={styles.thanks}>Thanks — we read every note.</p></div>;
  }

  if (step === "comment") {
    return (
      <form className={styles.box} onSubmit={sendComment}>
        <label className={styles.q} htmlFor={`fb-${episodeDate}`}>
          {liked === false
            ? "Sorry about that. What should we fix?"
            : "Thanks! Anything we got wrong, or you'd want more of?"}
        </label>
        <textarea
          id={`fb-${episodeDate}`}
          className={styles.text}
          rows={3}
          maxLength={2000}
          placeholder="A wrong score, a match we skipped, too long, too short…"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <div className={styles.row}>
          {failed && <span className={styles.err}>Couldn&apos;t send. Try again?</span>}
          <button type="button" className={styles.skip} onClick={() => go("done")}>
            Skip
          </button>
          <button type="submit" className={styles.send} disabled={sending || !comment.trim()}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className={`${styles.box} ${styles.askRow}`}>
      <span className={styles.q}>Was this episode worth your time?</span>
      <div className={styles.thumbs}>
        <button type="button" className={styles.thumb} onClick={() => rate(1)} aria-label="Yes">
          👍
        </button>
        <button type="button" className={styles.thumb} onClick={() => rate(-1)} aria-label="No">
          👎
        </button>
      </div>
    </div>
  );
}
