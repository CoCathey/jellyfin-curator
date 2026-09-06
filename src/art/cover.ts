import sharp from "sharp";

/** Jellyfin shows a collection as a poster, so the card is 2:3 even though the
 * source is a 16:9 backdrop: the backdrop fills the frame blurred, and a sharp
 * copy of it sits inset above the title. Cropping one backdrop to 2:3 instead
 * would throw away two thirds of the frame. */
export const COVER_WIDTH = 1000;
export const COVER_HEIGHT = 1500;
const INSET_WIDTH = 880;
const INSET_HEIGHT = Math.round((INSET_WIDTH * 9) / 16);
const MAX_LINES = 3;
/** Gap between the inset's bottom edge and the first title baseline, rule included. */
const TITLE_GAP = 150;
/** Optical centring: a block sitting dead centre reads as slightly low. */
const OPTICAL_LIFT = 0.9;

/** Helvetica-ish bold advances average a little over half the em; the SVG has no
 * text metrics, so lines are wrapped on this estimate and the font size steps
 * down for long titles rather than overflowing. */
const AVERAGE_ADVANCE = 0.55;

export interface CoverLayout {
  fontSize: number;
  lines: string[];
}

const escapeXml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c);

/** Greedy wrap on whole words; a word longer than the line is left to overflow
 * rather than hyphenated, which no shelf title has ever needed. */
export function wrapTitle(title: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of title.trim().split(/\s+/).filter((w) => w.length > 0)) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (candidate.length <= maxChars || line.length === 0) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

/** The largest size whose wrap fits in MAX_LINES. */
export function coverLayout(title: string): CoverLayout {
  for (const fontSize of [88, 78, 68, 58, 50]) {
    const lines = wrapTitle(title, Math.floor(INSET_WIDTH / (AVERAGE_ADVANCE * fontSize)));
    if (lines.length <= MAX_LINES) return { fontSize, lines };
  }
  const fontSize = 50;
  return { fontSize, lines: wrapTitle(title, Math.floor(INSET_WIDTH / (AVERAGE_ADVANCE * fontSize))).slice(0, MAX_LINES) };
}

/** Inset and title travel together, centred as one block, so a one-line title
 * does not leave a third of the card empty below it. */
export function blockGeometry(lineCount: number, fontSize: number): { insetTop: number; titleTop: number } {
  const lineHeight = Math.round(fontSize * 1.22);
  const height = INSET_HEIGHT + TITLE_GAP + (lineCount - 1) * lineHeight;
  const insetTop = Math.round(((COVER_HEIGHT - height) / 2) * OPTICAL_LIFT);
  return { insetTop, titleTop: insetTop + INSET_HEIGHT + TITLE_GAP };
}

function titleSvg(title: string): Buffer {
  const { fontSize, lines } = coverLayout(title);
  const lineHeight = Math.round(fontSize * 1.22);
  const { insetTop, titleTop } = blockGeometry(lines.length, fontSize);
  const rows = lines
    .map((line, i) => `<text x="${COVER_WIDTH / 2}" y="${titleTop + i * lineHeight}" class="t">${escapeXml(line)}</text>`)
    .join("");
  return Buffer.from(`<svg width="${COVER_WIDTH}" height="${COVER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <style>
    .t { fill: #ffffff; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-weight: 700;
         font-size: ${fontSize}px; text-anchor: middle; letter-spacing: -0.5px; }
  </style>
  <rect x="${(COVER_WIDTH - 120) / 2}" y="${insetTop + INSET_HEIGHT + 62}" width="120" height="4" rx="2" fill="#ffffff" fill-opacity="0.55"/>
  ${rows}
</svg>`);
}

/** Rounded so the inset reads as a card rather than a second crop. */
async function roundedInset(backdrop: Buffer): Promise<Buffer> {
  const mask = Buffer.from(
    `<svg width="${INSET_WIDTH}" height="${INSET_HEIGHT}"><rect width="${INSET_WIDTH}" height="${INSET_HEIGHT}" rx="20" ry="20" fill="#fff"/></svg>`,
  );
  return sharp(backdrop)
    .resize(INSET_WIDTH, INSET_HEIGHT, { fit: "cover" })
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

/** A poster-shaped cover for one shelf, built from a member's backdrop. */
export async function buildCoverCard(backdrop: Buffer, title: string): Promise<Buffer> {
  const background = await sharp(backdrop)
    .resize(COVER_WIDTH, COVER_HEIGHT, { fit: "cover", position: "attention" })
    .blur(22)
    .modulate({ brightness: 0.42, saturation: 1.1 })
    .toBuffer();
  const inset = await roundedInset(backdrop);
  const { fontSize, lines } = coverLayout(title);
  const { insetTop } = blockGeometry(lines.length, fontSize);
  return sharp(background)
    .composite([
      { input: inset, left: Math.round((COVER_WIDTH - INSET_WIDTH) / 2), top: insetTop },
      { input: titleSvg(title), left: 0, top: 0 },
    ])
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}
