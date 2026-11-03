import { sceneAt, type Compiled, type Layer } from './compile';
import type { Project } from './schema';
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
    const st = project.styles[l.style];
    if (st) {
      ctx.font = `${st.size}px "${st.font}", serif`;
      ctx.fillStyle = st.color;
      ctx.textAlign = st.anchor ?? 'center';
      ctx.textBaseline = 'middle';
      if (st.shadow) {
        ctx.shadowColor = st.shadow.color;
        ctx.shadowBlur = st.shadow.blur;
      }
      const lh = st.size * (st.line_height ?? 1.3);
      const lines = wrap(ctx, l.content, st.max_width ?? W - 240);
      const y0 = l.pos[1] - ((lines.length - 1) * lh) / 2;
      lines.forEach((line, i) => ctx.fillText(line, l.pos[0], y0 + i * lh));
    }
  } else {
    const src = l.kind === 'image' ? media.images.get(l.file) : media.videos.get(l.file);
    const nw = src instanceof HTMLVideoElement ? src.videoWidth : (src?.naturalWidth ?? 0);
    const nh = src instanceof HTMLVideoElement ? src.videoHeight : (src?.naturalHeight ?? 0);
    const [w, h] = l.size ?? [nw || 400, nh || 300];
    if (src && nw) ctx.drawImage(src, l.pos[0], l.pos[1], w, h);
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
