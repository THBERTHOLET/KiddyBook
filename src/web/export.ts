// Page pilotée par Playwright : rend l'image n° i à la demande.
import { compile } from '../shared/compile';
import { Media } from '../shared/media';
import { renderFrame } from '../shared/render';
import { fontFamily, ProjectSchema } from '../shared/schema';

const w = window as any;

(async () => {
  const project = ProjectSchema.parse(await (await fetch('/api/project')).json());
  const assets: string[] = await (await fetch('/api/assets')).json();
  const c = compile(project);
  const media = new Media();
  await media.loadFonts(assets);
  // force le chargement des polices utilisées par les styles
  await Promise.all(
    Object.values(project.styles).map((s) => document.fonts.load(`${s.size}px "${fontFamily(s.font)}"`).catch(() => [])),
  );
  await media.preload(c);

  const [W, H] = project.project.resolution;
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  w.__missing = media.missing;
  w.__frame = async (i: number, quality: number) => {
    const t = i / project.project.fps;
    await media.syncVideos(c, t, true);
    renderFrame(ctx, project, c, media, t);
    return canvas.toDataURL('image/jpeg', quality);
  };
  w.__ready = true;
})().catch((e) => {
  console.error(e);
  w.__error = String(e);
});
