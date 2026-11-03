import express from 'express';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectSchema, type Project } from '../shared/schema';
import { startExport, type Job } from './export';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const projectDir = resolve(process.env.PROJECT_DIR ?? join(root, 'projects', 'ep1'));
const projectFile = join(projectDir, 'project.json');
const PORT = Number(process.env.PORT ?? 5174);

const app = express();

/** Résout un chemin relatif en restant dans le dossier projet. */
function inProject(rel: string): string {
  const abs = resolve(projectDir, rel);
  if (abs !== projectDir && !abs.startsWith(projectDir + sep)) throw new Error('Chemin interdit');
  return abs;
}

function readProject(): unknown {
  return JSON.parse(readFileSync(projectFile, 'utf8'));
}

app.get('/api/project', (_req, res) => {
  res.json(readProject());
});

app.put('/api/project', express.json({ limit: '5mb' }), (req, res) => {
  const parsed = ProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    return;
  }
  writeFileSync(projectFile, JSON.stringify(req.body, null, 2) + '\n');
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

app.use('/files', express.static(projectDir, { acceptRanges: true }));
app.use('/exports', express.static(join(projectDir, 'exports')));

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
