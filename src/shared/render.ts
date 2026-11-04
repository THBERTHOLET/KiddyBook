import { sceneAt, type Compiled, type Layer } from './compile';
import { fontFamily, resolveStyle, type Effects, type Project, type Style } from './schema';
import type { Media } from './media';

function fade(t: number, t0: number, t1: number, fi: number, fo: number): number {
  let a = 1;
  if (fi > 0) a = Math.min(a, (t - t0) / fi);
  if (fo > 0) a = Math.min(a, (t1 - t) / fo);
  return Math.max(0, Math.min(1, a));
}

function placeholder(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, label: string) {
  ctx.save();
  ctx.fillStyle = 'rgba(120,120,120,0.25)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,80,80,0.9)';
  ctx.lineWidth = 3;
  ctx.setLineDash([14, 10]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = '22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`manquant : ${label}`, x + w / 2, y + h / 2, w - 20);
  ctx.restore();
}

function drawCover(ctx: CanvasRenderingContext2D, src: CanvasImageSource, sw: number, sh: number, W: number, H: number) {
  const k = Math.max(W / sw, H / sh);
  const w = sw * k;
  const h = sh * k;
  ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxW) {
        out.push(line);
        line = word;
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

// Canvas de travail réutilisés d'une image à l'autre (évite de réallouer 60 fois par seconde).
const scratch: Record<string, HTMLCanvasElement> = {};
function scratchCanvas(key: string, w: number, h: number): CanvasRenderingContext2D {
  const c = (scratch[key] ??= document.createElement('canvas'));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const g = c.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, w, h);
  return g;
}

function roundedRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

const shadowActive = (s: Effects['shadow']) => !!s && ((s.blur ?? 0) > 0 || !!s.x || !!s.y);
export const hasEffects = (fx?: Effects): fx is Effects =>
  !!fx &&
  !!(fx.rotation || fx.corner_radius || fx.feather || (fx.opacity != null && fx.opacity < 1) ||
    shadowActive(fx.shadow) || (fx.border?.width ?? 0) > 0);

/**
 * Dessine une image / vidéo avec ses effets. L'image est d'abord composée dans un canvas de travail
 * (arrondi → bords fondus → bordure) puis posée sur la scène avec ombre, rotation et opacité.
 */
function drawMedia(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  x: number,
  y: number,
  w: number,
  h: number,
  fx?: Effects,
) {
  if (!hasEffects(fx)) {
    ctx.drawImage(src, x, y, w, h);
    return;
  }
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  const r = fx.corner_radius ?? 0;

  const a = scratchCanvas('img', W, H);
  a.save();
  if (r > 0) {
    roundedRect(a, 0, 0, W, H, r);
    a.clip();
  }
  a.drawImage(src, 0, 0, W, H);
  a.restore();

  const f = fx.feather ?? 0;
  if (f > 0) {
    // masque : rectangle blanc rentré de `f`, flouté → l'image s'estompe sur ses bords
    const m = scratchCanvas('mask', W, H);
    m.filter = `blur(${f / 2}px)`;
    m.fillStyle = '#fff';
    roundedRect(m, f, f, Math.max(1, W - 2 * f), Math.max(1, H - 2 * f), Math.max(r - f, f / 2));
    m.fill();
    m.filter = 'none';
    a.globalCompositeOperation = 'destination-in';
    a.drawImage(m.canvas, 0, 0);
    a.globalCompositeOperation = 'source-over';
  }

  const b = fx.border;
  if (b && (b.width ?? 0) > 0) {
    const bw = b.width!;
    a.save();
    a.strokeStyle = b.color ?? '#ffffff';
    a.lineWidth = bw;
    roundedRect(a, bw / 2, bw / 2, W - bw, H - bw, r - bw / 2);
    a.stroke();
    if (b.style === 'double') {
      a.lineWidth = Math.max(1, bw / 3);
      roundedRect(a, bw * 1.8, bw * 1.8, W - bw * 3.6, H - bw * 3.6, r - bw * 1.8);
      a.stroke();
    }
    a.restore();
  }

  ctx.save();
  ctx.globalAlpha *= fx.opacity ?? 1;
  const s = fx.shadow;
  if (shadowActive(s)) {
    ctx.shadowColor = s!.color ?? 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = s!.blur ?? 0;
    ctx.shadowOffsetX = s!.x ?? 0;
    ctx.shadowOffsetY = s!.y ?? 0;
  }
  if (fx.rotation) {
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate((fx.rotation * Math.PI) / 180);
    ctx.drawImage(a.canvas, -w / 2, -h / 2, w, h);
  } else ctx.drawImage(a.canvas, x, y, w, h);
  ctx.restore();
}

export interface TextLayout {
  lines: string[];
  lh: number;
  width: number;
  height: number;
  anchor: 'left' | 'center' | 'right';
  /** style effectif (style nommé + surcharges du texte) */
  style: Style;
}

/** Règle la police sur `ctx` et calcule la mise en page d'un texte. Partagé par le rendu et l'éditeur. */
export function layoutText(
  ctx: CanvasRenderingContext2D,
  project: Project,
  l: Extract<Layer, { kind: 'text' }>,
  W: number,
): TextLayout | null {
  const base = project.styles[l.style];
  if (!base) return null;
  const st = resolveStyle(base, l.ref);
  ctx.font = `${st.italic ? 'italic ' : ''}${st.bold ? 'bold ' : ''}${st.size}px "${fontFamily(st.font)}", serif`;
  ctx.textAlign = st.anchor ?? 'center';
  ctx.textBaseline = 'middle';
  const lh = st.size * (st.line_height ?? 1.3);
  const boxWidth: number | undefined = l.ref?.width;
  const lines = wrap(ctx, l.content, boxWidth ?? st.max_width ?? W - 240);
  const textWidth = Math.max(...lines.map((s) => ctx.measureText(s).width), 1);
  // zone de texte explicite : c'est elle qui est sélectionnée, pas seulement le texte écrit dedans
  const width = boxWidth ?? textWidth;
  return { lines, lh, width, height: lines.length * lh, anchor: st.anchor ?? 'center', style: st };
}

function drawLayer(
  ctx: CanvasRenderingContext2D,
  project: Project,
  media: Media,
  l: Layer,
  alpha: number,
  W: number,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  if (l.kind === 'text') {
    const lay = layoutText(ctx, project, l, W);
    if (lay) {
      const st = lay.style;
      ctx.fillStyle = st.color;
      if (st.shadow) {
        ctx.shadowColor = st.shadow.color;
        ctx.shadowBlur = st.shadow.blur;
      }
      const y0 = l.pos[1] - ((lay.lines.length - 1) * lay.lh) / 2;
      lay.lines.forEach((line, i) => ctx.fillText(line, l.pos[0], y0 + i * lay.lh));
    }
  } else {
    const src = l.kind === 'image' ? media.images.get(l.file) : media.videos.get(l.file);
    const nw = src instanceof HTMLVideoElement ? src.videoWidth : (src?.naturalWidth ?? 0);
    const nh = src instanceof HTMLVideoElement ? src.videoHeight : (src?.naturalHeight ?? 0);
    const [w, h] = l.size ?? [nw || 400, nh || 300];
    if (src && nw) drawMedia(ctx, src, l.pos[0], l.pos[1], w, h, l.effects);
    else placeholder(ctx, l.pos[0], l.pos[1], w, h, l.file);
  }
  ctx.restore();
}

/** Rend l'image au temps global `t` (s). Même code pour l'aperçu et l'export. */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  project: Project,
  c: Compiled,
  media: Media,
  t: number,
) {
  const [W, H] = project.project.resolution;
  const s = sceneAt(c, t);
  const lt = t - s.start;

  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const bg = s.scene.background;
  if (bg?.startsWith('#')) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
  } else if (bg) {
    const img = media.images.get(bg);
    if (img) drawCover(ctx, img, img.naturalWidth, img.naturalHeight, W, H);
    else placeholder(ctx, 0, 0, W, H, bg);
  }

  for (const l of s.layers) {
    if (lt < l.t0 || lt >= l.t1) continue;
    drawLayer(ctx, project, media, l, fade(lt, l.t0, l.t1, l.fadeIn, l.fadeOut), W);
  }

  // fondu de scène à travers le noir
  const sa = fade(lt, 0, s.duration, s.fadeIn, s.fadeOut);
  if (sa < 1) {
    ctx.fillStyle = `rgba(0,0,0,${1 - sa})`;
    ctx.fillRect(0, 0, W, H);
  }

  for (const o of c.overlays) {
    if (t < o.t0 || t >= o.t1) continue;
    const v = media.videos.get(o.file);
    if (v && v.videoWidth) ctx.drawImage(v, 0, 0, W, H);
    else placeholder(ctx, W / 4, H / 4, W / 2, H / 2, o.file);
  }
  ctx.restore();
}
