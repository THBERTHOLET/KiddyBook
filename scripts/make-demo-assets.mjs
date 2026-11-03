// Génère des médias factices (fonds, illustration, sons, transitions WebM alpha) pour tester le moteur.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'projects/ep1';
const winget = join(process.env.LOCALAPPDATA ?? '', 'Microsoft/WinGet/Links/ffmpeg.exe');
const ffmpeg = process.env.FFMPEG_PATH ?? (existsSync(winget) ? winget : 'ffmpeg');
const a = (p) => join(root, 'assets', p);
for (const d of ['backgrounds', 'illustrations', 'audio', 'transitions', 'fonts']) mkdirSync(a(d), { recursive: true });

const run = (...args) => execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
const lavfi = (src, ...rest) => run('-f', 'lavfi', '-i', src, ...rest);

lavfi('color=c=0x2b1a10:s=1920x1080', '-frames:v', '1', a('backgrounds/couverture_grimoire.png'));
lavfi('color=c=0xf1e4c8:s=1920x1080', '-frames:v', '1', a('backgrounds/page_interieure.png'));
lavfi('color=c=0x6fa86b:s=900x600', '-vf', 'drawbox=x=40:y=40:w=820:h=520:color=0x2e5e2a:t=12', '-frames:v', '1', a('illustrations/scene_1.png'));
lavfi('sine=frequency=220:duration=12', '-af', 'volume=0.5', a('audio/background_music.mp3'));
lavfi('sine=frequency=1320:duration=1.5', '-af', 'afade=t=out:st=0.3:d=1.2', a('audio/magic_bell.mp3'));
lavfi('sine=frequency=440:duration=7', '-af', 'tremolo=f=4:d=0.7', a('audio/narration_page1.mp3'));
lavfi('anoisesrc=d=5:c=pink:a=0.3', a('audio/sfx_wind.mp3'));
for (const [name, d] of [['cover_open', 1.2], ['page_turn_right', 0.8]]) {
  // bandeau blanc semi-transparent qui balaye l'écran ; canal alpha VP9
  lavfi(
    `color=c=white:s=1920x1080:d=${d}:r=30`,
    '-vf', `format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(between(X,(T/${d})*2200-300,(T/${d})*2200),200,0)'`,
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', a(`transitions/${name}.webm`),
  );
}
console.log('Médias de démo créés dans', join(root, 'assets'));
