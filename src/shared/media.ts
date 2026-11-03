import type { Compiled, Layer } from './compile';

/** Chargement des médias côté navigateur (aperçu et page d'export). */
export class Media {
  images = new Map<string, HTMLImageElement | null>();
  videos = new Map<string, HTMLVideoElement | null>();
  private rev = new Map<string, number>();

  url(file: string): string {
    const path = file.split('/').map(encodeURIComponent).join('/');
    return `/files/${path}?v=${this.rev.get(file) ?? 0}`;
  }

  /** À appeler après l'envoi d'un nouveau fichier du même nom. */
  invalidate(file: string) {
    this.rev.set(file, (this.rev.get(file) ?? 0) + 1);
    this.images.delete(file);
    this.videos.delete(file);
  }

  get missing(): string[] {
    return [...this.images, ...this.videos].filter(([, v]) => !v).map(([k]) => k);
  }

  private loadImage(file: string): Promise<void> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => (this.images.set(file, img), resolve());
      img.onerror = () => (this.images.set(file, null), resolve());
      img.src = this.url(file);
    });
  }

  private loadVideo(file: string): Promise<void> {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.onloadeddata = () => (this.videos.set(file, v), resolve());
      v.onerror = () => (this.videos.set(file, null), resolve());
      v.src = this.url(file);
    });
  }

  async preload(c: Compiled) {
    const jobs: Promise<void>[] = [];
    for (const f of c.files.images) if (!this.images.has(f)) jobs.push(this.loadImage(f));
    for (const f of c.files.videos) if (!this.videos.has(f)) jobs.push(this.loadVideo(f));
    await Promise.all(jobs);
  }

  /** Charge les polices `assets/fonts/*` ; l'identifiant de police est le nom du fichier sans extension. */
  async loadFonts(assets: string[]) {
    const fonts = assets.filter((a) => /^assets\/fonts\/.+\.(ttf|otf|woff2?)$/i.test(a));
    await Promise.all(
      fonts.map(async (f) => {
        const family = f.split('/').pop()!.replace(/\.[^.]+$/, '');
        if ([...document.fonts].some((x) => x.family === family)) return;
        try {
          const face = new FontFace(family, `url(${this.url(f)})`);
          document.fonts.add(await face.load());
        } catch {
          /* police illisible : repli sur serif */
        }
      }),
    );
  }

  /**
   * Cale les vidéos actives sur le temps `t`.
   * exact = true (export, scrub) : attend chaque seek. Sinon lecture libre avec correction de dérive.
   */
  async syncVideos(c: Compiled, t: number, exact: boolean) {
    const wanted = new Map<string, number>();
    for (const s of c.scenes) {
      if (t < s.start || t >= s.end) continue;
      for (const l of s.layers) {
        if (l.kind === 'video' && t - s.start >= l.t0 && t - s.start < l.t1)
          wanted.set(l.file, t - s.start - l.t0);
      }
    }
    for (const o of c.overlays) if (t >= o.t0 && t < o.t1) wanted.set(o.file, t - o.t0);

    const jobs: Promise<void>[] = [];
    for (const [file, v] of this.videos) {
      if (!v) continue;
      const target = wanted.get(file);
      if (target == null) {
        if (!v.paused) v.pause();
        continue;
      }
      const clamped = Math.min(target, Math.max(0, (v.duration || target) - 0.001));
      if (exact) {
        if (!v.paused) v.pause();
        if (Math.abs(v.currentTime - clamped) > 1e-4) jobs.push(seek(v, clamped));
      } else if (v.paused) {
        v.currentTime = clamped;
        void v.play().catch(() => {});
      } else if (Math.abs(v.currentTime - clamped) > 0.25) {
        v.currentTime = clamped;
      }
    }
    await Promise.all(jobs);
  }

  pauseVideos() {
    for (const v of this.videos.values()) if (v && !v.paused) v.pause();
  }
}

function seek(v: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => (v.removeEventListener('seeked', done), resolve());
    v.addEventListener('seeked', done);
    v.currentTime = time;
  });
}

export type { Layer };
