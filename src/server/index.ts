import express from 'express';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectSchema, type Project } from '../shared/schema';
import { startExport, type Job } from './export';
import { playableVideo } from './proxy';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const projectsRoot = join(root, 'projects');
const lastFile = join(root, '.last-project');
const PORT = Number(process.env.PORT ?? 5174);

function initialProjectDir(): string {
  if (process.env.PROJECT_DIR) return resolve(process.env.PROJECT_DIR);
  if (existsSync(lastFile)) {
    const dir = join(projectsRoot, readFileSync(lastFile, 'utf8').trim());
    if (existsSync(join(dir, 'project.json'))) return dir;
  }
  return join(projectsRoot, 'ep1');
}

/** Dossier du projet ouvert ; change quand l'utilisateur ouvre un autre projet. */
let projectDir = initialProjectDir();
const projectFile = () => join(projectDir, 'project.json');

const app = express();

/** Résout un chemin relatif en restant dans le dossier projet. */
function inProject(rel: string): string {
  const abs = resolve(projectDir, rel);
  if (abs !== projectDir && !abs.startsWith(projectDir + sep)) throw new Error('Chemin interdit');
  return abs;
}

function readProject(): unknown {
  return JSON.parse(readFileSync(projectFile(), 'utf8'));
}

const DEFAULT_PROJECT = {
  project: { fps: 30, resolution: [1920, 1080], output_file: 'livre.mp4' },
  styles: {
    title_main: { font: 'serif', size: 64, color: '#ffffff', anchor: 'center' },
    narrative_body: { font: 'serif', size: 32, color: '#ffffff', anchor: 'center' },
  },
  global_audio_tracks: [],
  timeline: [{ type: 'cover', background: '#2b1a10', duration: 5, fade_in: 1, fade_out: 0.8, texts: [{ style: 'title_main', content: 'Mon livre', position: [960, 500], start: 0.5, fade_in: 0.8 }] }],
};

const projectName = () => relative(projectsRoot, projectDir) || projectDir;

app.get('/api/projects', (_req, res) => {
  const names = existsSync(projectsRoot)
    ? readdirSync(projectsRoot).filter((n) => existsSync(join(projectsRoot, n, 'project.json')))
    : [];
  res.json({ current: projectName(), projects: names });
});

function switchTo(name: string, res: express.Response) {
  if (current?.job.status === 'running') {
    res.status(409).json({ error: 'Un export est en cours' });
    return;
  }
  if (!/^[\w.-]+$/.test(name)) {
    res.status(400).json({ error: 'Nom invalide (lettres, chiffres, - _ . uniquement)' });
    return;
  }
  projectDir = join(projectsRoot, name);
  writeFileSync(lastFile, name);
  current = null;
  res.json({ ok: true, current: name });
}

app.post('/api/projects/open', express.json(), (req, res) => {
  const name = String(req.body?.name ?? '');
  if (!existsSync(join(projectsRoot, name, 'project.json'))) {
    res.status(404).json({ error: 'Projet introuvable' });
    return;
  }
  switchTo(name, res);
});

app.post('/api/projects/create', express.json(), (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!/^[\w.-]+$/.test(name)) {
    res.status(400).json({ error: 'Nom invalide (lettres, chiffres, - _ . uniquement)' });
    return;
  }
  const dir = join(projectsRoot, name);
  if (existsSync(dir)) {
    res.status(409).json({ error: 'Ce projet existe déjà' });
    return;
  }
  for (const d of ['backgrounds', 'illustrations', 'audio', 'transitions', 'fonts']) mkdirSync(join(dir, 'assets', d), { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(DEFAULT_PROJECT, null, 2) + '\n');
  switchTo(name, res);
});

app.get('/api/project', (_req, res) => {
  res.json(readProject());
});

app.put('/api/project', express.json({ limit: '5mb' }), (req, res) => {
  const parsed = ProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    return;
  }
  writeFileSync(projectFile(), JSON.stringify(req.body, null, 2) + '\n');
  res.json({ ok: true });
});

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(relative(projectDir, p).split(sep).join('/'));
  }
  return out;
}

app.get('/api/assets', (_req, res) => {
  res.json(walk(join(projectDir, 'assets')).sort());
});

app.post('/api/upload', express.raw({ type: '*/*', limit: '500mb' }), (req, res) => {
  try {
    const rel = String(req.query.path ?? '');
    if (!rel.startsWith('assets/')) throw new Error('Les fichiers doivent aller dans assets/');
    const abs = inProject(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, req.body as Buffer);
    res.json({ ok: true, path: rel });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Dossiers résolus à chaque requête, car le projet ouvert peut changer.
// Les vidéos que le navigateur ne décode pas (HEVC…) sont servies via une copie H.264.
app.get(/^\/files\/(.+\.(?:mp4|mov|m4v|mkv|webm))$/i, async (req, res, next) => {
  try {
    const rel = decodeURIComponent((req.params as any)[0]);
    const abs = inProject(rel);
    if (!existsSync(abs)) return next();
    // sendFile gère les requêtes Range ; dotfiles: .proxies/ commence par un point
    res.sendFile(await playableVideo(projectDir, rel), { dotfiles: 'allow' });
  } catch (e) {
    console.error('Vidéo illisible :', (e as Error).message);
    next();
  }
});
app.use('/files',(req, res, next) => express.static(projectDir, { acceptRanges: true })(req, res, next));
app.use('/exports', (req, res, next) => express.static(join(projectDir, 'exports'))(req, res, next));

// --- export ---
let current: { job: Job; cancel: () => void } | null = null;

app.post('/api/export', express.json(), (req, res) => {
  if (current?.job.status === 'running') {
    res.status(409).json({ error: 'Un export est déjà en cours' });
    return;
  }
  const parsed = ProjectSchema.safeParse(readProject());
  if (!parsed.success) {
    res.status(422).json({ error: 'Projet invalide', errors: parsed.error.issues.map((i) => i.message) });
    return;
  }
  const origin = String(req.body?.origin ?? `http://localhost:${PORT}`);
  current = startExport({
    project: parsed.data as Project,
    projectDir,
    origin,
    crf: Number(req.body?.crf ?? 18),
    jpegQuality: Number(req.body?.jpegQuality ?? 0.95),
  });
  res.json({ ok: true });
});

app.get('/api/export', (_req, res) => {
  res.json(current?.job ?? { status: 'idle' });
});

app.post('/api/export/cancel', (_req, res) => {
  current?.cancel();
  res.json({ ok: true });
});

// Production : sert le build du front
const dist = join(root, 'dist', 'web');
if (existsSync(dist)) app.use(express.static(dist));

app.listen(PORT, () => {
  console.log(`KiddyBooks API : http://localhost:${PORT}  (projet : ${projectDir})`);
});
