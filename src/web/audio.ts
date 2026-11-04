import { duckBreakpoints, duckGain, type AudioEvent, type Duck } from '../shared/compile';

/** Lecture WebAudio du mixage multipiste, au plus près de ce que fera ffmpeg. */
export class AudioPlayer {
  private ctx = new AudioContext();
  private buffers = new Map<string, AudioBuffer | null>();
  private nodes: AudioScheduledSourceNode[] = [];

  invalidate(file: string) {
    this.buffers.delete(file);
  }

  async preload(files: Iterable<string>, url: (f: string) => string) {
    await Promise.all(
      [...files]
        .filter((f) => !this.buffers.has(f))
        .map(async (f) => {
          try {
            const r = await fetch(url(f));
            if (!r.ok) throw new Error();
            this.buffers.set(f, await this.ctx.decodeAudioData(await r.arrayBuffer()));
          } catch {
            this.buffers.set(f, null);
          }
        }),
    );
  }

  async start(events: AudioEvent[], fromT: number, duck?: Duck) {
    this.stop();
    await this.ctx.resume();
    const now = this.ctx.currentTime + 0.05;
    for (const e of events) {
      const buf = this.buffers.get(e.file);
      if (!buf) continue;
      const avail = Math.max(0, buf.duration - e.offset); // durée jouable après le point de départ
      const len = e.loop ? e.duration! : Math.min(e.duration ?? avail, avail);
      const end = e.start + len;
      if (end <= fromT) continue;

      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = e.loop;
      const gain = this.ctx.createGain();
      src.connect(gain).connect(this.ctx.destination);

      const u0 = Math.max(0, fromT - e.start); // temps déjà écoulé dans l'événement
      const when = now + Math.max(0, e.start - fromT);
      // la musique est atténuée sous les narrations (même courbe que dans l'export)
      const ducked = duck && e.role === 'music' ? duck : undefined;
      const g = (u: number) =>
        e.volume *
        Math.max(0, Math.min(e.fadeIn > 0 ? u / e.fadeIn : 1, e.fadeOut > 0 ? (len - u) / e.fadeOut : 1, 1)) *
        (ducked ? duckGain(ducked, e.start + u) : 1);
      const duckPts = ducked ? duckBreakpoints(ducked).map((t) => t - e.start) : [];
      const pts = [u0, e.fadeIn, len - e.fadeOut, len, ...duckPts]
        .filter((u) => u >= u0 && u <= len)
        .sort((a, b) => a - b);
      gain.gain.setValueAtTime(g(pts[0]), when);
      for (const u of pts.slice(1)) gain.gain.linearRampToValueAtTime(g(u), when + (u - u0));

      src.start(when, e.loop ? (e.offset + u0) % buf.duration : e.offset + u0);
      src.stop(when + (len - u0));
      this.nodes.push(src);
    }
  }

  stop() {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* déjà arrêté */
      }
    }
    this.nodes = [];
  }
}
