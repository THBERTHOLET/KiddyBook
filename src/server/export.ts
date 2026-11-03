import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser } from 'playwright-core';
import { compile, type AudioEvent } from '../shared/compile';
import type { Project } from '../shared/schema';

const run = promisify(execFile);

export interface Job {
  status: 'running' | 'done' | 'error' | 'cancelled';
  frame: number;
  total: number;
  output?: string;
  error?: string;
  warnings: string[];
  startedAt: number;
}

export function findBin(name: 'ffmpeg' | 'ffprobe'): string {
  const env = process.env[name.toUpperCase() + '_PATH'];
  if (env) return env;
  const link = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', `${name}.exe`);
  return existsSync(link) ? link : name;
}

async function probeDuration(file: string): Promise<number | undefined> {
  try {
    const { stdout } = await run(findBin('ffprobe'), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
    ]);
    const d = parseFloat(stdout);
    return Number.isFinite(d) ? d : undefined;
  } catch {
    return undefined;
  }
}

const f = (n: number) => +n.toFixed(4);

/** Mixage multipiste : chaque événement est calé (adelay), volumé, fondu, puis sommé. */
async function buildAudio(events: AudioEvent[], total: number, dir: string, warnings: string[]) {
  const inputs: string[] = [];
  const chains: string[] = [];
  for (const e of events) {
    const path = join(dir, e.file);
    if (!existsSync(path)) {
      warnings.push(`Audio introuvable, ignoré : ${e.file}`);
      continue;
    }
    if (e.start >= total) continue;
    let dur = e.duration;
    if (dur == null) {
      const full = await probeDuration(path);
      if (full != null) dur = Math.max(0.05, full - e.offset);
    }
    if (dur != null) dur = Math.min(dur, total - e.start);
    const k = chains.length; // numéro d'entrée ffmpeg (inputs contient aussi les options)
    if (e.loop) inputs.push('-stream_loop', '-1');
    inputs.push('-i', path);
    let c = `[${k}:a]aformat=sample_rates=48000:channel_layouts=stereo`;
    // extrait : on saute `offset` secondes dans le fichier puis on garde `dur`
    const trim = [e.offset > 0 ? `start=${f(e.offset)}` : '', dur != null ? `duration=${f(dur)}` : ''].filter(Boolean);
    if (trim.length) c += `,atrim=${trim.join(':')},asetpts=PTS-STARTPTS`;
    if (e.volume !== 1) c += `,volume=${f(e.volume)}`;
    if (e.fadeIn > 0) c += `,afade=t=in:st=0:d=${f(e.fadeIn)}`;
    if (e.fadeOut > 0 && dur != null) c += `,afade=t=out:st=${f(Math.max(0, dur - e.fadeOut))}:d=${f(e.fadeOut)}`;
    const ms = Math.round(e.start * 1000);
    if (ms > 0) c += `,adelay=${ms}|${ms}`;
    chains.push(`${c}[a${k}]`);
  }
  if (!chains.length) return null;
  const labels = chains.map((_, i) => `[a${i}]`).join('');
  const filter = [
    ...chains,
    `${labels}amix=inputs=${chains.length}:normalize=0:dropout_transition=0,alimiter=limit=0.95,apad,atrim=duration=${f(total)}[aout]`,
  ].join(';');
  return { inputs, filter };
}

export interface ExportOptions {
  project: Project;
  projectDir: string;
  origin: string; // origine de la page d'export (Vite en dev, serveur en prod)
  crf: number;
  jpegQuality: number;
}

export function startExport(opts: ExportOptions): { job: Job; cancel: () => void } {
  const { project, projectDir } = opts;
  const c = compile(project);
  const fps = project.project.fps;
  const frames = Math.max(1, Math.round(c.total * fps));
  const job: Job = { status: 'running', frame: 0, total: frames, warnings: [], startedAt: Date.now() };
  let cancelled = false;
  let browser: Browser | undefined;
  let ff: ReturnType<typeof spawn> | undefined;
  let mixChild: ChildProcess | undefined;
  let ffClosed = false;
  /**
   * Annulation immédiate : l'état passe tout de suite à « cancelled » (un nouvel export redevient possible),
   * et tout ce qui tourne est arrêté. La boucle de rendu ne doit surtout pas pouvoir rester bloquée.
   */
  const cancel = () => {
    if (job.status !== 'running') return;
    cancelled = true;
    job.status = 'cancelled';
    mixChild?.kill();
    ff?.kill();
    void browser?.close().catch(() => {});
  };

  (async () => {
    const exportsDir = join(projectDir, 'exports');
    mkdirSync(exportsDir, { recursive: true });
    const out = join(exportsDir, project.project.output_file);
    // Passe 1 : mixage de toutes les pistes dans un WAV unique. Garder plusieurs entrées audio
    // dans le même ffmpeg que la vidéo en pipe provoque des blocages (files de paquets pleines).
    const mix = await buildAudio(c.audio, c.total, projectDir, job.warnings);
    const mixFile = join(exportsDir, '.mix.wav');
    if (mix) {
      try {
        const p = run(findBin('ffmpeg'), [
          '-y', '-hide_banner', '-loglevel', 'error', ...mix.inputs,
          '-filter_complex', mix.filter, '-map', '[aout]', '-c:a', 'pcm_s16le', mixFile,
        ], { maxBuffer: 10 * 1024 * 1024 });
        mixChild = p.child;
        await p;
      } catch (e: any) {
        if (cancelled) return;
        throw new Error(`Mixage audio échoué : ${String(e.stderr ?? e.message).slice(-800)}`);
      }
    }
    if (cancelled) return;
    const audio = mix ? { inputs: ['-i', mixFile] } : null;

    for (const channel of ['msedge', 'chrome']) {
      try {
        browser = await chromium.launch({ channel, headless: true });
        break;
      } catch {
        /* essaie le suivant */
      }
    }
    if (!browser) throw new Error('Ni Microsoft Edge ni Google Chrome ne sont utilisables.');
    if (cancelled) return;

    const page = await browser.newPage();
    page.on('pageerror', (e) => job.warnings.push(`Page d'export : ${e.message}`));
    await page.goto(`${opts.origin}/export.html`);
    await page.waitForFunction('window.__ready === true', undefined, { timeout: 60000 });
    const missing = (await page.evaluate('window.__missing')) as string[];
    for (const m of missing) job.warnings.push(`Média introuvable (placeholder rendu) : ${m}`);

    const [W, H] = project.project.resolution;
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
      ...(audio?.inputs ?? []),
      ...(audio ? ['-map', '0:v', '-map', '1:a'] : ['-map', '0:v', '-an']),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', String(opts.crf), '-pix_fmt', 'yuv420p',
      '-vf', `scale=${W}:${H}`, '-r', String(fps),
      ...(audio ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'] : []),
      '-t', String(f(c.total)), '-movflags', '+faststart', out,
    ];
    ff = spawn(findBin('ffmpeg'), args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    ff.stderr!.on('data', (d) => (stderr += d));
    const exited = new Promise<number>((res) =>
      ff!.on('close', (code) => {
        ffClosed = true;
        res(code ?? -1);
      }),
    );
    ff.stdin!.on('error', () => {});

    for (let i = 0; i < frames && !cancelled && !ffClosed; i++) {
      const dataUrl = (await page.evaluate(
        ([idx, q]) => (window as any).__frame(idx, q),
        [i, opts.jpegQuality] as const,
      )) as string;
      const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      // attente du vidage du tampon, mais jamais au-delà de la fin d'ffmpeg (sinon blocage à l'annulation)
      if (!ff.stdin!.write(buf)) await Promise.race([new Promise((r) => ff!.stdin!.once('drain', r)), exited]);
      job.frame = i + 1;
    }
    if (!ffClosed) ff.stdin!.end();
    const code = await exited;
    if (cancelled) {
      return;
    } else if (code !== 0) {
      throw new Error(`ffmpeg a échoué (code ${code}) : ${stderr.slice(-800)}`);
    } else {
      job.status = 'done';
      job.output = project.project.output_file;
    }
  })()
    .catch((e) => {
      if (cancelled) return; // erreurs attendues : navigateur fermé, ffmpeg tué…
      job.status = 'error';
      job.error = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      void browser?.close().catch(() => {});
      const exportsDir = join(projectDir, 'exports');
      rmSync(join(exportsDir, '.mix.wav'), { force: true });
      // une annulation ou un échec laisse un MP4 incomplet : on ne le garde pas
      if (ff && job.status !== 'done') rmSync(join(exportsDir, project.project.output_file), { force: true });
    });

  return { job, cancel };
}
