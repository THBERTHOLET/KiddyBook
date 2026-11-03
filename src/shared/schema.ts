import { z } from 'zod';

const Vec2 = z.tuple([z.number(), z.number()]);

/** Champs temporels communs. Tous les temps sont en secondes, relatifs au début de la scène. */
const timing = {
  /** Libellé donné par l'utilisateur dans l'éditeur (sans effet sur le rendu). */
  name: z.string().optional(),
  start: z.number().min(0).optional(),
  duration: z.number().positive().optional(),
  fade_in: z.number().min(0).optional(),
  fade_out: z.number().min(0).optional(),
};

/**
 * Famille de police utilisée par le canvas. Accepte un identifiant (« Grimoire »), un nom de fichier
 * (« Grimoire.ttf ») ou un chemin (« assets/fonts/Grimoire.ttf ») : on garde le nom sans dossier ni extension,
 * qui est celui sous lequel les polices de assets/fonts/ sont enregistrées.
 */
export function fontFamily(font: string): string {
  return font.replace(/^.*[\\/]/, '').replace(/\.(ttf|otf|woff2?)$/i, '');
}

export const StyleSchema = z.object({
  font: z.string(),
  size: z.number().positive(),
  color: z.string(),
  anchor: z.enum(['left', 'center', 'right']).optional(),
  line_height: z.number().positive().optional(),
  max_width: z.number().positive().optional(),
  shadow: z.object({ color: z.string(), blur: z.number().min(0) }).optional(),
});

export const TextSchema = z.object({
  type: z.literal('text').optional(),
  style: z.string(),
  content: z.string(),
  position: Vec2,
  ...timing,
});

/** Effets visuels d'une image ou d'une vidéo. Tout est optionnel ; les valeurs sont en pixels du projet. */
export const EffectsSchema = z.object({
  opacity: z.number().min(0).max(1).optional(),
  /** degrés, autour du centre */
  rotation: z.number().optional(),
  corner_radius: z.number().min(0).optional(),
  /** largeur du dégradé qui fond les bords de l'image dans le décor */
  feather: z.number().min(0).optional(),
  shadow: z
    .object({
      color: z.string().optional(),
      blur: z.number().min(0).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    })
    .optional(),
  border: z
    .object({
      color: z.string().optional(),
      width: z.number().min(0).optional(),
      style: z.enum(['solid', 'double']).optional(),
    })
    .optional(),
});

/** Image : `position` est le coin supérieur gauche. */
export const ImageSchema = z.object({
  type: z.literal('image').optional(),
  file: z.string(),
  position: Vec2,
  size: Vec2.optional(),
  effects: EffectsSchema.optional(),
  ...timing,
});

/** Vidéo (WebM alpha supporté) : `position` est le coin supérieur gauche. */
export const VideoSchema = z.object({
  type: z.literal('video'),
  file: z.string(),
  position: Vec2,
  size: Vec2.optional(),
  effects: EffectsSchema.optional(),
  ...timing,
});

export const ElementSchema = z.union([
  VideoSchema,
  z.object({ ...ImageSchema.shape, type: z.literal('image') }),
  TextSchema,
]);

export const AudioSchema = z.object({
  name: z.string().optional(),
  file: z.string(),
  start: z.number().min(0).optional(),
  duration: z.number().positive().optional(),
  volume: z.number().min(0).optional(),
  loop: z.boolean().optional(),
  fade_in: z.number().min(0).optional(),
  fade_out: z.number().min(0).optional(),
});

/** Vidéo superposée (alpha) entre deux scènes. Par défaut centrée sur la coupure. */
export const TransitionSchema = z.object({
  type: z.literal('video_overlay'),
  file: z.string(),
  duration: z.number().positive(),
  offset: z.number().optional(),
});

export const SceneSchema = z.object({
  type: z.enum(['cover', 'page', 'end']),
  page_index: z.number().int().optional(),
  background: z.string().optional(),
  duration: z.number().positive(),
  fade_in: z.number().min(0).optional(),
  fade_out: z.number().min(0).optional(),
  illustration: ImageSchema.optional(),
  elements: z.array(ElementSchema).optional(),
  texts: z.array(TextSchema).optional(),
  audio: z.array(AudioSchema).optional(),
  transition_to_next: TransitionSchema.optional(),
});

export const ProjectSchema = z
  .object({
    project: z.object({
      fps: z.number().int().min(1).max(120),
      resolution: z.tuple([z.number().int().positive(), z.number().int().positive()]),
      output_file: z.string().min(1),
    }),
    styles: z.record(z.string(), StyleSchema),
    global_audio_tracks: z.array(AudioSchema).optional(),
    timeline: z.array(SceneSchema).min(1),
  })
  .superRefine((p, ctx) => {
    p.timeline.forEach((scene, i) => {
      const texts = [
        ...(scene.texts ?? []),
        ...(scene.elements ?? []).filter((e) => !('file' in e)),
      ] as { style: string }[];
      texts.forEach((t) => {
        if (!(t.style in p.styles)) {
          ctx.addIssue({
            code: 'custom',
            path: ['timeline', i],
            message: `Style inconnu : « ${t.style} »`,
          });
        }
      });
    });
  });

export type Effects = z.infer<typeof EffectsSchema>;
export type Style = z.infer<typeof StyleSchema>;
export type TextEl = z.infer<typeof TextSchema>;
export type ImageEl = z.infer<typeof ImageSchema>;
export type VideoEl = z.infer<typeof VideoSchema>;
export type Element = z.infer<typeof ElementSchema>;
export type AudioCfg = z.infer<typeof AudioSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Project = z.infer<typeof ProjectSchema>;
