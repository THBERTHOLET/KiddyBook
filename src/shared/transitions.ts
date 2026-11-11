import type { TransitionEffect } from './schema';

export const EFFECT_LABELS: Record<TransitionEffect, string> = {
  page_turn: 'Page qui se tourne (livre ouvert)',
  crossfade: 'Fondu enchaîné',
  dip_black: 'Fondu par le noir',
  slide_left: 'Glissement depuis la droite',
  slide_right: 'Glissement depuis la gauche',
  push_left: 'Poussée vers la gauche',
  push_right: 'Poussée vers la droite',
  wipe_left: 'Balayage vers la gauche',
  wipe_right: 'Balayage vers la droite',
  zoom_in: 'Zoom avant',
  circle: 'Ouverture en cercle',
};

const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/**
 * Compose la transition entre deux images complètes `a` (sortante) et `b` (entrante) de même taille.
 * `p` : avancement linéaire de 0 (tout `a`) à 1 (tout `b`).
 */
export function drawTransition(
  ctx: CanvasRenderingContext2D,
  effect: TransitionEffect,
  p: number,
  a: CanvasImageSource,
  b: CanvasImageSource,
  W: number,
  H: number,
) {
  const e = ease(Math.max(0, Math.min(1, p)));
  ctx.save();
  switch (effect) {
    case 'crossfade':
      ctx.drawImage(a, 0, 0);
      ctx.globalAlpha = e;
      ctx.drawImage(b, 0, 0);
      break;
    case 'dip_black':
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = e < 0.5 ? 1 - 2 * e : 2 * e - 1;
      ctx.drawImage(e < 0.5 ? a : b, 0, 0);
      break;
    case 'slide_left':
    case 'slide_right': {
      ctx.drawImage(a, 0, 0);
      const dir = effect === 'slide_left' ? 1 : -1;
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 40;
      ctx.drawImage(b, dir * W * (1 - e), 0);
      break;
    }
    case 'push_left':
    case 'push_right': {
      const dir = effect === 'push_left' ? 1 : -1;
      ctx.drawImage(a, -dir * W * e, 0);
      ctx.drawImage(b, dir * W * (1 - e), 0);
      break;
    }
    case 'wipe_left':
    case 'wipe_right': {
      ctx.drawImage(a, 0, 0);
      const w = W * e;
      ctx.beginPath();
      if (effect === 'wipe_left') ctx.rect(W - w, 0, w, H);
      else ctx.rect(0, 0, w, H);
      ctx.clip();
      ctx.drawImage(b, 0, 0);
      break;
    }
    case 'zoom_in': {
      ctx.drawImage(b, 0, 0);
      const k = 1 + 0.4 * e;
      ctx.globalAlpha = 1 - e;
      ctx.drawImage(a, (W - W * k) / 2, (H - H * k) / 2, W * k, H * k);
      break;
    }
    case 'circle':
      ctx.drawImage(a, 0, 0);
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, e * Math.hypot(W, H) * 0.5, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(b, 0, 0);
      break;
    case 'page_turn':
      pageTurn(ctx, e, a, b, W, H);
      break;
  }
  ctx.restore();
}

/**
 * Livre ouvert, reliure au centre : la page de droite (moitié droite de `a`) se tourne vers la gauche.
 * Sa face arrière est la moitié gauche de `b` ; dessous apparaît la moitié droite de `b`.
 * La feuille est dessinée en fines bandes, un peu plus hautes à mesure qu'elles s'éloignent de la reliure
 * (perspective), avec ombre portée et ombrage.
 */
function pageTurn(ctx: CanvasRenderingContext2D, e: number, a: CanvasImageSource, b: CanvasImageSource, W: number, H: number) {
  const hx = W / 2;
  const theta = Math.PI * e;
  const c = Math.cos(theta);
  const s = Math.sin(theta);

  // pages immobiles : gauche de A, droite de B
  ctx.drawImage(a, 0, 0, hx, H, 0, 0, hx, H);
  ctx.drawImage(b, hx, 0, hx, H, hx, 0, hx, H);

  const edge = hx + hx * c; // bord libre de la feuille

  // ombre portée de la feuille sur la page dessous
  if (s > 0.02) {
    const reach = W * 0.14;
    const x0 = c >= 0 ? edge : edge - reach;
    const g = ctx.createLinearGradient(c >= 0 ? edge : edge, 0, c >= 0 ? edge + reach : edge - reach, 0);
    g.addColorStop(0, `rgba(0,0,0,${0.38 * s})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x0, 0, reach, H);
  }

  // la feuille
  const step = 3;
  const src = c >= 0 ? a : b;
  for (let u = 0; u < hx; u += step) {
    const u1 = Math.min(u + step, hx);
    const d0 = hx + u * c;
    const d1 = hx + u1 * c;
    const w = Math.abs(d1 - d0);
    if (w < 0.01) continue;
    const sx = c >= 0 ? hx + u : hx - u1;
    const k = 1 + 0.09 * s * (u / hx); // le bord libre se rapproche du spectateur
    const dh = H * k;
    ctx.drawImage(src, sx, 0, u1 - u, H, Math.min(d0, d1) - 0.4, (H - dh) / 2, w + 0.8, dh);
  }

  // ombrage de la feuille : plus sombre vers le bord libre, et à la verticale
  const left = Math.min(hx, edge);
  const width = Math.abs(edge - hx);
  if (width > 1) {
    const g = ctx.createLinearGradient(c >= 0 ? hx : edge, 0, c >= 0 ? edge : hx, 0);
    const dark = 0.12 + 0.3 * s;
    // dégradé orienté de la reliure (clair) vers le bord libre (sombre)
    g.addColorStop(0, c >= 0 ? 'rgba(0,0,0,0)' : `rgba(0,0,0,${dark})`);
    g.addColorStop(1, c >= 0 ? `rgba(0,0,0,${dark})` : 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(left, 0, width, H);
  }

  // pli de la reliure
  const fold = ctx.createLinearGradient(hx - 14, 0, hx + 14, 0);
  fold.addColorStop(0, 'rgba(0,0,0,0)');
  fold.addColorStop(0.5, `rgba(0,0,0,${0.28 * Math.min(1, s * 3)})`);
  fold.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = fold;
  ctx.fillRect(hx - 14, 0, 28, H);
}
