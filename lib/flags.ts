// Drapeaux par code pays ISO 3 lettres, exprimés comme valeur CSS `background`.
// Approximations par gradients : suffisant à 16×12 px (carte) ou 20×14 px (détail).
// Les drapeaux scandinaves utilisent un empilement de gradients pour dessiner la croix.

const FLAGS: Record<string, string> = {
  // ── Tricolores verticales ──────────────────────────────────────────────────
  FRA: "linear-gradient(to right, #002395 0 33%, #ffffff 33% 66%, #ed2939 66%)",
  ITA: "linear-gradient(to right, #008c45 0 33%, #f4f9ff 33% 66%, #cd212a 66%)",
  IRL: "linear-gradient(to right, #169b62 0 33%, #ffffff 33% 66%, #ff883e 66%)",
  BEL: "linear-gradient(to right, #1a1814 0 33%, #ffd03a 33% 66%, #ed2939 66%)",
  ROU: "linear-gradient(to right, #002b7f 0 33%, #fcd116 33% 66%, #ce1126 66%)",
  MDA: "linear-gradient(to right, #003da5 0 33%, #fff200 33% 66%, #cc092f 66%)",
  CAN: "linear-gradient(to right, #d52b1e 0 25%, #ffffff 25% 75%, #d52b1e 75%)",
  PER: "linear-gradient(to right, #d91023 0 33%, #ffffff 33% 66%, #d91023 66%)",
  POR: "linear-gradient(to right, #006837 0 40%, #d91023 40%)",

  // ── Tricolores horizontales ────────────────────────────────────────────────
  // Espagne : rouge/jaune/rouge ratio 1:2:1, avec une ellipse foncée à 1/3 de la
  // gauche pour suggérer les armoiries.
  ESP: "radial-gradient(ellipse 10% 16% at 33% 50%, #7a1014 0 100%, transparent 100%), linear-gradient(to bottom, #c60b1e 0 25%, #ffc400 25% 75%, #c60b1e 75%)",
  GER: "linear-gradient(to bottom, #1a1814 0 33%, #d12a2a 33% 66%, #f0c419 66%)",
  AUT: "linear-gradient(to bottom, #ed2939 0 33%, #ffffff 33% 66%, #ed2939 66%)",
  // Argentine : céleste/blanc/céleste avec un disque jaune (Soleil de Mai)
  // au centre du bandeau blanc.
  ARG: "radial-gradient(circle at 50% 50%, #f6b40e 0 14%, transparent 14%), linear-gradient(to bottom, #75aadb 0 33%, #ffffff 33% 66%, #75aadb 66%)",
  HUN: "linear-gradient(to bottom, #ce2939 0 33%, #ffffff 33% 66%, #436f4d 66%)",
  BUL: "linear-gradient(to bottom, #ffffff 0 33%, #00966e 33% 66%, #d62612 66%)",
  NED: "linear-gradient(to bottom, #ae1c28 0 33%, #ffffff 33% 66%, #21468b 66%)",
  LUX: "linear-gradient(to bottom, #ed2939 0 33%, #ffffff 33% 66%, #00a3e0 66%)",
  LTU: "linear-gradient(to bottom, #fdb913 0 33%, #006a44 33% 66%, #c1272d 66%)",
  EST: "linear-gradient(to bottom, #0072ce 0 33%, #000000 33% 66%, #ffffff 66%)",
  RUS: "linear-gradient(to bottom, #ffffff 0 33%, #1a3a8a 33% 66%, #c6363c 66%)",
  SRB: "linear-gradient(to bottom, #c6363c 0 33%, #0c4076 33% 66%, #ffffff 66%)",
  CRO: "linear-gradient(to bottom, #ff0000 0 33%, #ffffff 33% 66%, #171796 66%)",
  SVK: "linear-gradient(to bottom, #ee1c25 0 33%, #ffffff 33% 66%, #0b4ea2 66%)",
  SLO: "linear-gradient(to bottom, #ffffff 0 33%, #0000ff 33% 66%, #ff0000 66%)",
  COL: "linear-gradient(to bottom, #fcd116 0 50%, #003893 50% 75%, #ce1126 75%)",
  ECU: "linear-gradient(to bottom, #fcd116 0 50%, #003893 50% 75%, #ce1126 75%)",
  VEN: "linear-gradient(to bottom, #fcd116 0 33%, #003893 33% 66%, #ce1126 66%)",
  IRN: "linear-gradient(to bottom, #239f40 0 33%, #ffffff 33% 66%, #da0000 66%)",
  EGY: "linear-gradient(to bottom, #ce1126 0 33%, #ffffff 33% 66%, #000000 66%)",
  SYR: "linear-gradient(to bottom, #ce1126 0 33%, #ffffff 33% 66%, #000000 66%)",
  YEM: "linear-gradient(to bottom, #ce1126 0 33%, #ffffff 33% 66%, #000000 66%)",

  // ── Bandes horizontales (autres ratios) ────────────────────────────────────
  POL: "linear-gradient(to bottom, #ffffff 0 50%, #c6363c 50%)",
  UKR: "linear-gradient(to bottom, #0057b8 0 50%, #ffd700 50%)",
  MON: "linear-gradient(to bottom, #ed2939 0 50%, #ffffff 50%)",
  IDN: "linear-gradient(to bottom, #ed2939 0 50%, #ffffff 50%)",
  CZE: "linear-gradient(to bottom, #ffffff 0 50%, #d7141a 50%)",
  LIE: "linear-gradient(to bottom, #002b7f 0 50%, #ce1126 50%)",
  BLR: "linear-gradient(to bottom, #c8313e 0 66%, #007c30 66%)",
  LAT: "linear-gradient(to bottom, #9e3039 0 40%, #ffffff 40% 60%, #9e3039 60%)",
  URU: "linear-gradient(to bottom, #ffffff 0 50%, #7b3f00 50% 100%), linear-gradient(to bottom, #0038a8 0 12.5%, #ffffff 12.5% 25%, #0038a8 25% 37.5%, #ffffff 37.5% 50%, #0038a8 50% 62.5%, #ffffff 62.5% 75%, #0038a8 75% 87.5%, #ffffff 87.5%)",
  USA: "linear-gradient(to bottom, #b22234 0 14%, #ffffff 14% 28%, #b22234 28% 42%, #ffffff 42% 56%, #b22234 56% 70%, #ffffff 70% 84%, #b22234 84%)",

  // ── Croix scandinaves (couches : croix couleur, croix blanche, fond) ───────
  NOR: "linear-gradient(0deg, transparent 40%, #00205b 40% 60%, transparent 60%), linear-gradient(90deg, transparent 28%, #00205b 28% 38%, transparent 38%), linear-gradient(0deg, transparent 33%, #ffffff 33% 66%, transparent 66%), linear-gradient(90deg, transparent 22%, #ffffff 22% 44%, transparent 44%), #ed2939",
  SWE: "linear-gradient(0deg, transparent 40%, #fecc00 40% 60%, transparent 60%), linear-gradient(90deg, transparent 28%, #fecc00 28% 38%, transparent 38%), #006aa7",
  DEN: "linear-gradient(0deg, transparent 40%, #ffffff 40% 60%, transparent 60%), linear-gradient(90deg, transparent 28%, #ffffff 28% 38%, transparent 38%), #c8102e",
  FIN: "linear-gradient(0deg, transparent 40%, #003580 40% 60%, transparent 60%), linear-gradient(90deg, transparent 28%, #003580 28% 38%, transparent 38%), #ffffff",
  ISL: "linear-gradient(0deg, transparent 40%, #dc1e35 40% 60%, transparent 60%), linear-gradient(90deg, transparent 28%, #dc1e35 28% 38%, transparent 38%), linear-gradient(0deg, transparent 33%, #ffffff 33% 66%, transparent 66%), linear-gradient(90deg, transparent 22%, #ffffff 22% 44%, transparent 44%), #02529c",

  // ── Croix carrée (Suisse) ──────────────────────────────────────────────────
  SUI: "linear-gradient(0deg, transparent 35%, #ffffff 35% 65%, transparent 65%), linear-gradient(90deg, transparent 35%, #ffffff 35% 65%, transparent 65%), #ff0000",

  // ── Royaume-Uni (Union Jack) ───────────────────────────────────────────────
  // Empilement : croix rouge de Saint-Georges (la + au-dessus), croix blanche,
  // diagonales rouges de Saint-Patrick, diagonales blanches de Saint-André,
  // fond bleu marine. Les diagonales sont faussées par le ratio 16×12 mais
  // l'image générale reste lisible à petite taille.
  GBR: "linear-gradient(0deg, transparent 42%, #cf142b 42% 58%, transparent 58%), linear-gradient(90deg, transparent 42%, #cf142b 42% 58%, transparent 58%), linear-gradient(0deg, transparent 34%, #ffffff 34% 66%, transparent 66%), linear-gradient(90deg, transparent 34%, #ffffff 34% 66%, transparent 66%), linear-gradient(45deg, transparent 45%, #cf142b 45% 55%, transparent 55%), linear-gradient(-45deg, transparent 45%, #cf142b 45% 55%, transparent 55%), linear-gradient(45deg, transparent 38%, #ffffff 38% 62%, transparent 62%), linear-gradient(-45deg, transparent 38%, #ffffff 38% 62%, transparent 62%), #00247d",

  // ── Disque (Japon) ─────────────────────────────────────────────────────────
  JPN: "radial-gradient(circle at 50% 50%, #bc002d 0 28%, #ffffff 28%)",

  // ── Grèce : 9 bandes alternées (canton bleu non rendu, trop petit) ─────────
  GRE: "linear-gradient(to bottom, #0d5eaf 0 11.1%, #ffffff 11.1% 22.2%, #0d5eaf 22.2% 33.3%, #ffffff 33.3% 44.4%, #0d5eaf 44.4% 55.5%, #ffffff 55.5% 66.6%, #0d5eaf 66.6% 77.7%, #ffffff 77.7% 88.8%, #0d5eaf 88.8%)",

  // ── Australie / NZ (simplifiés : bleu marine + bandes/croix abandonnées) ──
  AUS: "linear-gradient(to bottom, #012169 0 100%)",
  NZL: "linear-gradient(to bottom, #012169 0 100%)",

  // ── Fonds quasi-unis (les détails ne se rendent pas à 16×12) ───────────────
  CHI: "linear-gradient(to bottom, #ffffff 0 50%, #d52b1e 50%)",
  TUR: "linear-gradient(to bottom, #e30a17 0 100%)",
  TUN: "linear-gradient(to bottom, #e70013 0 100%)",
  MAR: "linear-gradient(to bottom, #c1272d 0 100%)",
  CHN: "linear-gradient(to bottom, #de2910 0 100%)",
  HKG: "linear-gradient(to bottom, #de2910 0 100%)",
  KOR: "linear-gradient(to bottom, #ffffff 0 100%)",
  KAZ: "linear-gradient(to bottom, #00afca 0 100%)",
  ISR: "linear-gradient(to bottom, #ffffff 0 25%, #0038b8 25% 35%, #ffffff 35% 65%, #0038b8 65% 75%, #ffffff 75%)",
  IND: "linear-gradient(to bottom, #ff9933 0 33%, #ffffff 33% 66%, #138808 66%)",
  PAK: "linear-gradient(to right, #ffffff 0 25%, #006600 25%)",
  THA: "linear-gradient(to bottom, #ed1c24 0 17%, #ffffff 17% 33%, #241d4f 33% 66%, #ffffff 66% 83%, #ed1c24 83%)",
  BRA: "linear-gradient(to bottom, #009c3b 0 100%)",
  MEX: "linear-gradient(to right, #006847 0 33%, #ffffff 33% 66%, #ce1126 66%)",
  RSA: "linear-gradient(to bottom, #007a4d 0 100%)",
  GEO: "linear-gradient(to bottom, #ffffff 0 100%)",
  AZE: "linear-gradient(to bottom, #00b9e4 0 33%, #ef3340 33% 66%, #509e2f 66%)",
  ARM: "linear-gradient(to bottom, #d90012 0 33%, #0033a0 33% 66%, #f2a800 66%)",
  BIH: "linear-gradient(to bottom, #002395 0 100%)",
};

const FALLBACK_BG = "linear-gradient(to right, #888 0 100%)";

// Renvoie la valeur CSS `background` correspondant à un code pays.
// Insensible à la casse, fallback vers un dégradé gris si le code est inconnu.
export function flagBackground(code: string | null | undefined): string {
  if (!code) return FALLBACK_BG;
  return FLAGS[code.toUpperCase()] ?? FALLBACK_BG;
}
