import styles from "@/styles/ListenOn.module.css";
import { LISTEN_LINKS } from "@/lib/site";

// Glyphes monochromes (couleur = currentColor), comme sur la plupart des
// sites de podcasts plutôt que les badges officiels en couleur
export function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M5.64 16.36A9 9 0 1 1 18.36 16.36" />
      <path d="M8.11 13.89A5.5 5.5 0 1 1 15.89 13.89" />
      <circle cx="12" cy="10" r="2.1" fill="currentColor" stroke="none" />
      <rect x="10.7" y="13.6" width="2.6" height="7.6" rx="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SpotifyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
    </svg>
  );
}

// Plateformes affichées, dans l'ordre — seules celles qui ont un lien
export const PLATFORMS = [
  { key: "apple", label: "Apple Podcasts", href: LISTEN_LINKS.apple, Icon: AppleIcon },
  { key: "spotify", label: "Spotify", href: LISTEN_LINKS.spotify, Icon: SpotifyIcon },
].filter((p) => p.href);

// Rangée « Listen on » sous le lecteur
export default function ListenOn() {
  if (PLATFORMS.length === 0) return null;
  return (
    <div className={styles.row}>
      <span className={styles.label}>Listen on</span>
      <div className={styles.pills}>
        {PLATFORMS.map(({ key, label, href, Icon }) => (
          <a key={key} href={href} className={styles.pill} target="_blank" rel="noopener noreferrer">
            <Icon />
            {label}
          </a>
        ))}
      </div>
    </div>
  );
}
