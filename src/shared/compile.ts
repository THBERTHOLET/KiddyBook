import type { Effects, Project, Scene } from './schema';

interface LayerBase {
  /** Objet du projet dont la couche est issue (permet à l'éditeur de le modifier). */
  ref: any;
  /** temps de scène (s) */
  t0: number;
  t1: number;
  fadeIn: number;
  fadeOut: number;
}
export type Layer = LayerBase &
  (
    | { kind: 'text'; style: string; content: string; pos: [number, number] }
    | { kind: 'image' | 'video'; file: string; pos: [number, number]; size?: [number, number]; effects?: Effects }
  );

export interface CompiledScene {
  index: number;
  start: number;
  end: number;
  duration: number;
  fadeIn: number;
  fadeOut: number;
  scene: Scene;
  layers: Layer[];
}

/** Vidéo superposée, en temps global. */
export interface Overlay {
  file: string;
  t0: number;
  t1: number;
}

export type AudioRole = 'narration' | 'music' | 'sfx';

/** Piste audio à plat, en temps global. */
export interface AudioEvent {
  file: string;
  role: AudioRole;
  start: number;
  /** Durée de lecture ; indéfinie = durée naturelle du fichier. Toujours définie si `loop`. */
  duration?: number;
  volume: number;
  loop: boolean;
  fadeIn: number;
  fadeOut: number;
  /** Point de départ dans le fichier source (s). */
  offset: number;
}

/** Atténuation de la musique : `intervals` = plages de narration, en temps global. */
export interface Duck {
  /** gain linéaire atteint pendant la narration (0.25 ≈ -12 dB) */
  level: number;
  attack: number;
  release: number;
  intervals: [number, number][];
}

export interface Compiled {
  total: number;
  scenes: CompiledScene[];
  overlays: Overlay[];
  audio: AudioEvent[];
  duck?: Duck;
  /** Fichiers référencés, par catégorie. */
  files: { images: Set<string>; videos: Set<string>; audio: Set<string> };
}

/** Durées (s) des fichiers audio, mesurées par ffprobe côté serveur. */
export type Durations = Record<string, number>;

function timed(
  e: { start?: number; duration?: number; fade_in?: number; fade_out?: number },
  sceneDuration: number,
  /** plage imposée par un passage audio synchronisé (temps de scène) */
  sync?: { start: number; end: number },
): LayerBase {
  const base = sync ? sync.start + (e.start ?? 0) : (e.start ?? 0);
  const t0 = Math.min(base, sceneDuration);
  const natural = sync ? sync.end : sceneDuration;
  const t1 = Math.min(e.duration != null ? t0 + e.duration : natural, sceneDuration);
  return { ref: e, t0, t1: Math.max(t0, t1), fadeIn: e.fade_in ?? 0, fadeOut: e.fade_out ?? 0 };
}

/** Durée jouée d'un passage audio non bouclé, si elle est connue. */
function clipLength(a: { file: string; duration?: number; offset?: number }, durations: Durations): number | undefined {
  if (a.duration != null) return a.duration;
  const full = durations[a.file];
  return full != null ? Math.max(0.05, full - (a.offset ?? 0)) : undefined;
}

export function compile(project: Project, durations: Durations = {}): Compiled {
  const scenes: CompiledScene[] = [];
  const overlays: Overlay[] = [];
  const audio: AudioEvent[] = [];
  const files = { images: new Set<string>(), videos: new Set<string>(), audio: new Set<string>() };

  let cursor = 0;
  for (const [index, scene] of project.timeline.entries()) {
    const start = cursor;

    // Passages audio de la scène (temps de scène). Les boucles se calent sur la durée finale, calculée après.
    const clips = (scene.audio ?? []).map((a) => ({
      a,
      role: a.role ?? 'sfx',
      s: a.start ?? 0,
      len: a.loop ? undefined : clipLength(a, durations),
    }));

    // Durée automatique : fin de la dernière narration + marge
    let duration = scene.duration;
    if (scene.auto_duration) {
      const ends = clips.filter((c) => c.role === 'narration' && c.len != null && !c.a.loop).map((c) => c.s + c.len!);
      if (ends.length) duration = Math.max(0.5, Math.max(...ends) + (scene.end_pad ?? 1));
    }
    const end = start + duration;
    const layers: Layer[] = [];

    // passages synchronisables, par id
    const syncs = new Map<string, { start: number; end: number }>();
    for (const c of clips) if (c.a.id && c.len != null) syncs.set(c.a.id, { start: c.s, end: c.s + c.len });

    if (scene.background && !scene.background.startsWith('#')) files.images.add(scene.background);

    const pushMedia = (kind: 'image' | 'video', e: any) => {
      layers.push({
        kind,
        file: e.file,
        pos: e.position,
        size: e.size,
        effects: e.effects,
        ...timed(e, duration),
      });
      (kind === 'image' ? files.images : files.videos).add(e.file);
    };
    const pushText = (e: any) =>
      layers.push({
        kind: 'text',
        style: e.style,
        content: e.content,
        pos: e.position,
        ...timed(e, duration, e.sync ? syncs.get(e.sync) : undefined),
      });

    if (scene.illustration) pushMedia('image', scene.illustration);
    for (const e of scene.elements ?? []) {
      if ('file' in e) pushMedia(e.type === 'video' ? 'video' : 'image', e);
      else pushText(e);
    }
    for (const t of scene.texts ?? []) pushText(t);

    for (const c of clips) {
      const { a } = c;
      files.audio.add(a.file);
      audio.push({
        file: a.file,
        role: c.role,
        start: start + c.s,
        duration: a.loop ? (a.duration ?? duration - c.s) : c.len,
        volume: a.volume ?? 1,
        loop: !!a.loop,
        fadeIn: a.fade_in ?? 0,
        fadeOut: a.fade_out ?? 0,
        offset: a.offset ?? 0,
      });
    }

    const tr = scene.transition_to_next;
    if (tr && index < project.timeline.length - 1) {
      const t0 = end + (tr.offset ?? -tr.duration / 2);
      overlays.push({ file: tr.file, t0: Math.max(0, t0), t1: Math.max(0, t0) + tr.duration });
      files.videos.add(tr.file);
    }

    scenes.push({
      index,
      start,
      end,
      duration,
      fadeIn: scene.fade_in ?? 0,
      fadeOut: scene.fade_out ?? 0,
      scene,
      layers,
    });
    cursor = end;
  }
  const total = cursor;

  for (const a of project.global_audio_tracks ?? []) {
    const s = a.start ?? 0;
    files.audio.add(a.file);
    audio.push({
      file: a.file,
      role: a.role ?? 'music',
      start: s,
      duration: a.loop ? (a.duration ?? Math.max(0.1, total - s)) : clipLength(a, durations),
      volume: a.volume ?? 1,
      loop: !!a.loop,
      fadeIn: a.fade_in ?? 0,
      fadeOut: a.fade_out ?? 0,
      offset: a.offset ?? 0,
    });
  }

  let duck: Duck | undefined;
  const d = project.ducking;
  if (d?.enabled) {
    const intervals = audio
      .filter((e) => e.role === 'narration' && !e.loop && e.duration != null)
      .map((e): [number, number] => [e.start, e.start + e.duration!]);
    if (intervals.length) {
      duck = {
        level: Math.pow(10, (d.level_db ?? -12) / 20),
        attack: Math.max(0.01, d.attack ?? 0.4),
        release: Math.max(0.01, d.release ?? 0.8),
        intervals,
      };
    }
  }

  return { total, scenes, overlays, audio, duck, files };
}

export function sceneAt(c: Compiled, t: number): CompiledScene {
  for (const s of c.scenes) if (t >= s.start && t < s.end) return s;
  return c.scenes[c.scenes.length - 1];
}

/** Gain de la musique à l'instant `t` : 1 hors narration, `level` pendant, avec descente et remontée linéaires. */
export function duckGain(d: Duck, t: number): number {
  let env = 0;
  for (const [a, b] of d.intervals) {
    env = Math.max(env, Math.min(1, (t - (a - d.attack)) / d.attack, (b + d.release - t) / d.release));
  }
  return 1 - (1 - d.level) * Math.max(0, env);
}

/** Instants où la courbe d'atténuation change de pente (pour la programmer dans WebAudio). */
export function duckBreakpoints(d: Duck): number[] {
  return d.intervals.flatMap(([a, b]) => [a - d.attack, a, b, b + d.release]);
}
