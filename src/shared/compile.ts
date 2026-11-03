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

/** Piste audio à plat, en temps global. */
export interface AudioEvent {
  file: string;
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

export interface Compiled {
  total: number;
  scenes: CompiledScene[];
  overlays: Overlay[];
  audio: AudioEvent[];
  /** Fichiers référencés, par catégorie. */
  files: { images: Set<string>; videos: Set<string>; audio: Set<string> };
}

function timed(
  e: { start?: number; duration?: number; fade_in?: number; fade_out?: number },
  sceneDuration: number,
): LayerBase {
  const t0 = Math.min(e.start ?? 0, sceneDuration);
  const t1 = Math.min(e.duration != null ? t0 + e.duration : sceneDuration, sceneDuration);
  return { ref: e, t0, t1, fadeIn: e.fade_in ?? 0, fadeOut: e.fade_out ?? 0 };
}

export function compile(project: Project): Compiled {
  const scenes: CompiledScene[] = [];
  const overlays: Overlay[] = [];
  const audio: AudioEvent[] = [];
  const files = { images: new Set<string>(), videos: new Set<string>(), audio: new Set<string>() };

  let cursor = 0;
  for (const [index, scene] of project.timeline.entries()) {
    const start = cursor;
    const end = start + scene.duration;
    const layers: Layer[] = [];

    if (scene.background && !scene.background.startsWith('#')) files.images.add(scene.background);

    const pushMedia = (kind: 'image' | 'video', e: any) => {
      layers.push({
        kind,
        file: e.file,
        pos: e.position,
        size: e.size,
        effects: e.effects,
        ...timed(e, scene.duration),
      });
      (kind === 'image' ? files.images : files.videos).add(e.file);
    };
    const pushText = (e: any) =>
      layers.push({
        kind: 'text',
        style: e.style,
        content: e.content,
        pos: e.position,
        ...timed(e, scene.duration),
      });

    if (scene.illustration) pushMedia('image', scene.illustration);
    for (const e of scene.elements ?? []) {
      if ('file' in e) pushMedia(e.type === 'video' ? 'video' : 'image', e);
      else pushText(e);
    }
    for (const t of scene.texts ?? []) pushText(t);

    for (const a of scene.audio ?? []) {
      const s = start + (a.start ?? 0);
      files.audio.add(a.file);
      audio.push({
        file: a.file,
        start: s,
        duration: a.loop ? (a.duration ?? end - s) : a.duration,
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
      duration: scene.duration,
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
      start: s,
      duration: a.loop ? (a.duration ?? Math.max(0.1, total - s)) : a.duration,
      volume: a.volume ?? 1,
      loop: !!a.loop,
      fadeIn: a.fade_in ?? 0,
      fadeOut: a.fade_out ?? 0,
      offset: a.offset ?? 0,
    });
  }

  return { total, scenes, overlays, audio, files };
}

export function sceneAt(c: Compiled, t: number): CompiledScene {
  for (const s of c.scenes) if (t >= s.start && t < s.end) return s;
  return c.scenes[c.scenes.length - 1];
}
