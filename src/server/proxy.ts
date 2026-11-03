import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { findBin } from './export';

const run = promisify(execFile);

/** Codecs que le navigateur sait décoder. HEVC, ProRes, etc. passent par une copie H.264. */
const BROWSER_OK = new Set(['h264', 'vp8', 'vp9', 'av1']);

const pending = new Map<string, Promise<string>>();
const codecCache = new Map<string, string>();

async function videoCodec(path: string, mtime: number): Promise<string> {
  const key = `${path}:${mtime}`;
  const hit = codecCache.get(key);
  if (hit) return hit;
  const { stdout } = await run(findBin('ffprobe'), [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path,
  ]);
  const codec = stdout.trim().split(/\r?\n/)[0] ?? '';
  codecCache.set(key, codec);
  return codec;
}

/**
 * Renvoie le fichier à servir au navigateur pour une vidéo du projet : l'original s'il est lisible,
 * sinon une copie H.264 créée dans `.proxies/` (l'export ffmpeg, lui, lit toujours l'original).
 */
export async function playableVideo(projectDir: string, rel: string): Promise<string> {
  const abs = join(projectDir, rel);
  const mtime = statSync(abs).mtimeMs;
  let codec = '';
  try {
    codec = await videoCodec(abs, mtime);
  } catch {
    return abs; // ffprobe indisponible : on laisse le navigateur essayer
  }
  if (!codec || BROWSER_OK.has(codec)) return abs;

  const proxy = join(projectDir, '.proxies', rel.replace(/[\\/]/g, '__') + `.${Math.round(mtime)}.mp4`);
  if (existsSync(proxy)) return proxy;
  let job = pending.get(proxy);
  if (!job) {
    mkdirSync(dirname(proxy), { recursive: true });
    const tmp = proxy + '.part.mp4';
    console.log(`Conversion ${codec} → H.264 : ${rel}`);
    job = run(findBin('ffmpeg'), [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', abs,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-an', '-movflags', '+faststart', tmp,
    ]).then(() => {
      renameSync(tmp, proxy);
      return proxy;
    });
    pending.set(proxy, job);
    job.finally(() => pending.delete(proxy)).catch(() => {});
  }
  return job;
}
