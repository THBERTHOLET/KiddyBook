import { compile, sceneAt, type Compiled } from '../shared/compile';
import { Media } from '../shared/media';
import { renderFrame } from '../shared/render';
import { ProjectSchema, type Project, type Scene } from '../shared/schema';
import { AudioPlayer } from './audio';
import { areaField, checkField, fmtTime, h, numField, row, selectField, textField, vecField } from './ui';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let project: Project;
let compiled: Compiled;
let assets: string[] = [];
let selScene = 0;
let tab: 'scene' | 'styles' | 'audio' | 'media' | 'project' = 'scene';
let t = 0;
let playing = false;

const media = new Media();
const audio = new AudioPlayer();
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;

// ---------- chargement / sauvegarde ----------

const setStatus = (msg: string, err = false) => {
  const el = $('status');
  el.textContent = msg;
  el.className = err ? 'err' : '';
};

let saveTimer: number | undefined;
function scheduleSave() {
  setStatus('Modifié…');
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    const r = await fetch('/api/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(project),
    });
    if (r.ok) setStatus('Enregistré');
    else {
      const { errors } = await r.json();
      setStatus(`Non enregistré : ${errors[0].path} — ${errors[0].message}`, true);
    }
  }, 600);
}

async function refreshAssets() {
  assets = await (await fetch('/api/assets')).json();
  await media.loadFonts(assets);
  const ext = (re: RegExp) => assets.filter((a) => re.test(a));
  const lists: Record<string, string[]> = {
    'dl-img': ext(/\.(png|jpe?g|webp|gif)$/i),
    'dl-audio': ext(/\.(mp3|wav|ogg|m4a|flac)$/i),
    'dl-video': ext(/\.(webm|mp4|mov)$/i),
    'dl-font': [
      ...assets.filter((a) => a.startsWith('assets/fonts/')).map((a) => a.split('/').pop()!.replace(/\.[^.]+$/, '')),
      ...Object.values(project?.styles ?? {}).map((s) => s.font),
    ],
  };
  for (const [id, values] of Object.entries(lists)) {
    document.getElementById(id)?.remove();
    document.body.append(h('datalist', { id }, ...[...new Set(values)].map((v) => h('option', { value: v }))));
  }
}

// ---------- changements ----------

/** Modification de valeur (frappe) : pas de reconstruction des panneaux, pour garder le focus. */
async function changed() {
  const parsed = ProjectSchema.safeParse(project);
  compiled = compile(project);
  const wasPlaying = playing;
  if (wasPlaying) pause();
  await Promise.all([
    media.preload(compiled),
    audio.preload(compiled.files.audio, (f) => media.url(f)),
  ]);
  t = Math.min(t, compiled.total);
  renderSceneList();
  renderTimeline();
  await draw();
  if (wasPlaying) play();
  if (parsed.success) scheduleSave();
  else {
    const i = parsed.error.issues[0];
    setStatus(`Invalide : ${i.path.join('.')} — ${i.message}`, true);
  }
}

/** Modification de structure (ajout, suppression, déplacement) : reconstruit tout. */
async function rebuild() {
  await changed();
  renderInspector();
}

// ---------- aperçu ----------

let drawing = false;
async function draw(exact = true) {
  if (drawing) return;
  drawing = true;
  try {
    const [W, H] = project.project.resolution;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    await media.syncVideos(compiled, t, exact);
    renderFrame(ctx, project, compiled, media, t);
    if ($<HTMLInputElement>('safe').checked) drawSafe(W, H);
  } finally {
    drawing = false;
  }
  $('time').textContent = `${fmtTime(t)} / ${fmtTime(compiled.total)}`;
  const head = document.querySelector<HTMLElement>('#timeline .head');
  if (head) head.style.left = `${(t / compiled.total) * 100}%`;
}

function drawSafe(W: number, H: number) {
  ctx.save();
  ctx.strokeStyle = 'rgba(0,255,200,.6)';
  ctx.lineWidth = 2;
  ctx.setLineDash([12, 8]);
  ctx.strokeRect(W * 0.05, H * 0.05, W * 0.9, H * 0.9);
  ctx.restore();
}

let wallStart = 0;
let tStart = 0;
function play() {
  if (t >= compiled.total) t = 0;
  playing = true;
  $('play').textContent = '⏸';
  tStart = t;
  wallStart = performance.now();
  void audio.start(compiled.audio, t);
  const tick = async () => {
    if (!playing) return;
    t = tStart + (performance.now() - wallStart) / 1000;
    if (t >= compiled.total) {
      t = compiled.total;
      pause();
    }
    await draw(false);
    if (playing) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function pause() {
  playing = false;
  $('play').textContent = '▶';
  audio.stop();
  media.pauseVideos();
}

async function seek(newT: number) {
  const was = playing;
  if (was) pause();
  t = Math.max(0, Math.min(newT, compiled.total));
  const s = sceneAt(compiled, t);
  if (s.index !== selScene) {
    selScene = s.index;
    renderSceneList();
    if (tab === 'scene') renderInspector();
  }
  await draw();
  if (was) play();
}

$('play').onclick = () => (playing ? pause() : play());
$('safe').onchange = () => draw();
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) {
    e.preventDefault();
    $('play').click();
  }
});

// ---------- liste des scènes + timeline ----------

function sceneLabel(s: Scene, i: number) {
  return s.type === 'page' ? `Page ${s.page_index ?? i}` : s.type === 'cover' ? 'Couverture' : 'Fin';
}

function renderSceneList() {
  const box = $('scenes');
  box.replaceChildren(
    ...project.timeline.map((s, i) =>
      h(
        'div',
        {
          class: 'scene-item' + (i === selScene ? ' sel' : ''),
          onclick: () => {
            selScene = i;
            tab = 'scene';
            void seek(compiled.scenes[i].start);
            renderInspector();
          },
        },
        h('span', { class: 'name' }, `${i + 1}. ${sceneLabel(s, i)}`),
        h('span', { class: 'dur' }, `${s.duration}s`),
      ),
    ),
    h(
      'div',
      { class: 'add-row' },
      h('button', { onclick: () => addScene('page') }, '+ Page'),
      h('button', { onclick: () => addScene('cover') }, '+ Couv.'),
      h('button', { onclick: () => addScene('end') }, '+ Fin'),
    ),
  );
}

function addScene(type: Scene['type']) {
  const pages = project.timeline.filter((s) => s.type === 'page').length;
  const scene: Scene = { type, duration: 6, fade_in: 0.5, fade_out: 0.5, texts: [] };
  if (type === 'page') scene.page_index = pages + 1;
  project.timeline.splice(selScene + 1, 0, scene);
  selScene += 1;
  tab = 'scene';
  void rebuild().then(() => seek(compiled.scenes[selScene].start));
}

function renderTimeline() {
  const box = $('timeline');
  box.replaceChildren(
    ...compiled.scenes.map((s) =>
      h('div', { class: 'seg' + (s.index === selScene ? ' sel' : ''), style: `width:${(s.duration / compiled.total) * 100}%` }, `${s.index + 1}`),
    ),
    h('div', { class: 'head' }),
  );
}
$('timeline').addEventListener('click', (e) => {
  const r = $('timeline').getBoundingClientRect();
  void seek(((e.clientX - r.left) / r.width) * compiled.total);
});

// ---------- inspecteur ----------

function renderInspector() {
  const tabs: [typeof tab, string][] = [['scene', 'Scène'], ['styles', 'Styles'], ['audio', 'Audio'], ['media', 'Médias'], ['project', 'Projet']];
  const pane = { scene: scenePane, styles: stylesPane, audio: audioPane, media: mediaPane, project: projectPane }[tab]();
  $('inspector').replaceChildren(
    h('div', { class: 'tabs' }, ...tabs.map(([k, label]) => h('button', { class: k === tab ? 'on' : '', onclick: () => ((tab = k), renderInspector()) }, label))),
    h('div', { class: 'pane' }, ...pane),
  );
}

const fieldset = (title: string, extra: (Node | null)[], ...rows: HTMLElement[]) =>
  h('fieldset', {}, h('legend', {}, title, ...extra), ...rows);

const delBtn = (fn: () => void) => h('button', { class: 'small danger', title: 'Supprimer', onclick: fn }, '✕');

function moveItem<T>(arr: T[], i: number, d: number) {
  const j = i + d;
  if (j < 0 || j >= arr.length) return false;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  return true;
}

function timingRows(o: any, withDuration = true) {
  return [
    row('Début (s)', numField(o, 'start', changed, { min: 0, optional: true })),
    ...(withDuration ? [row('Durée (s)', numField(o, 'duration', changed, { min: 0.1, optional: true }))] : []),
    row('Fondu', numField(o, 'fade_in', changed, { min: 0, optional: true }), h('span', { class: 'hint' }, 'in'), numField(o, 'fade_out', changed, { min: 0, optional: true }), h('span', { class: 'hint' }, 'out')),
  ];
}

function layerForm(o: any, kind: 'text' | 'image' | 'video', title: string, onDelete?: () => void, onMove?: (d: number) => void) {
  const extra = [
    ...(onMove ? [h('button', { class: 'small', onclick: () => onMove(-1) }, '↑'), h('button', { class: 'small', onclick: () => onMove(1) }, '↓')] : []),
    ...(onDelete ? [delBtn(onDelete)] : []),
  ];
  if (kind === 'text') {
    return fieldset(title, extra,
      row('Style', selectField(o, 'style', Object.keys(project.styles), changed)),
      areaField(o, 'content', changed),
      row('Position', ...vecField(o, 'position', changed)),
      ...timingRows(o),
    );
  }
  return fieldset(title, extra,
    row('Fichier', textField(o, 'file', changed, { list: kind === 'image' ? 'dl-img' : 'dl-video' })),
    row('Position', ...vecField(o, 'position', changed)),
    row('Taille', ...vecField(o, 'size', changed, { optional: true })),
    ...timingRows(o),
  );
}

function audioForm(o: any, title: string, onDelete: () => void) {
  return fieldset(title, [delBtn(onDelete)],
    row('Fichier', textField(o, 'file', changed, { list: 'dl-audio' })),
    row('Début (s)', numField(o, 'start', changed, { min: 0, optional: true })),
    row('Durée (s)', numField(o, 'duration', changed, { min: 0.1, optional: true })),
    row('Volume', numField(o, 'volume', changed, { min: 0, step: 0.05, optional: true })),
    row('Fondu', numField(o, 'fade_in', changed, { min: 0, optional: true }), h('span', { class: 'hint' }, 'in'), numField(o, 'fade_out', changed, { min: 0, optional: true }), h('span', { class: 'hint' }, 'out')),
    row('Boucle', checkField(o, 'loop', changed)),
  );
}

function scenePane(): HTMLElement[] {
  const s = project.timeline[selScene];
  const tl = project.timeline;
  const defaultPos = (): [number, number] => [project.project.resolution[0] / 2, project.project.resolution[1] * 0.85];
  const firstStyle = Object.keys(project.styles)[0] ?? '';

  const out: HTMLElement[] = [
    fieldset(`Scène ${selScene + 1}`, [
      h('button', { class: 'small', onclick: () => moveItem(tl, selScene, -1) && (selScene--, rebuild()) }, '↑'),
      h('button', { class: 'small', onclick: () => moveItem(tl, selScene, 1) && (selScene++, rebuild()) }, '↓'),
      h('button', { class: 'small', title: 'Dupliquer', onclick: () => (tl.splice(selScene + 1, 0, structuredClone(s)), selScene++, rebuild()) }, '⧉'),
      tl.length > 1 ? delBtn(() => (tl.splice(selScene, 1), (selScene = Math.max(0, selScene - 1)), rebuild())) : null,
    ],
      row('Type', selectField(s, 'type', ['cover', 'page', 'end'], rebuild)),
      row('N° de page', numField(s, 'page_index', changed, { step: 1, optional: true })),
      row('Fond', textField(s, 'background', changed, { list: 'dl-img', optional: true })),
      row('Durée (s)', numField(s, 'duration', changed, { min: 0.5 })),
      row('Fondu', numField(s, 'fade_in', changed, { min: 0, optional: true }), h('span', { class: 'hint' }, 'in'), numField(s, 'fade_out', changed, { min: 0, optional: true }), h('span', { class: 'hint' }, 'out')),
    ),
  ];

  // illustration
  if (s.illustration) out.push(layerForm(s.illustration, 'image', 'Illustration', () => (delete s.illustration, rebuild())));
  else out.push(h('button', { onclick: () => ((s.illustration = { file: '', position: [460, 140], size: [1000, 640], start: 0.3, fade_in: 0.5 }), rebuild()) }, '+ Illustration'));

  // éléments (couverture, vidéos, images libres)
  (s.elements ??= []).forEach((e, i) => {
    const kind = 'file' in e ? (e.type === 'video' ? 'video' : 'image') : 'text';
    out.push(layerForm(e, kind, `Élément ${i + 1} (${kind})`, () => (s.elements!.splice(i, 1), rebuild()), (d) => moveItem(s.elements!, i, d) && rebuild()));
  });

  // textes
  (s.texts ??= []).forEach((e, i) =>
    out.push(layerForm(e, 'text', `Texte ${i + 1}`, () => (s.texts!.splice(i, 1), rebuild()), (d) => moveItem(s.texts!, i, d) && rebuild())),
  );
  out.push(
    h('div', { class: 'row' },
      h('button', { onclick: () => (s.texts!.push({ style: firstStyle, content: 'Nouveau texte', position: defaultPos(), start: 0.5, fade_in: 0.5 }), rebuild()) }, '+ Texte'),
      h('button', { onclick: () => (s.elements!.push({ type: 'video', file: '', position: [0, 0], size: project.project.resolution }), rebuild()) }, '+ Vidéo'),
    ),
  );

  // audio
  (s.audio ??= []).forEach((a, i) => out.push(audioForm(a, `Audio ${i + 1}`, () => (s.audio!.splice(i, 1), rebuild()))));
  out.push(h('button', { onclick: () => (s.audio!.push({ file: '', start: 0, volume: 1 }), rebuild()) }, '+ Piste audio'));

  // transition
  if (s.transition_to_next) {
    const tr = s.transition_to_next;
    out.push(fieldset('Transition vers la suivante', [delBtn(() => (delete s.transition_to_next, rebuild()))],
      row('Vidéo', textField(tr, 'file', changed, { list: 'dl-video' })),
      row('Durée (s)', numField(tr, 'duration', changed, { min: 0.1 })),
      row('Décalage', numField(tr, 'offset', changed, { optional: true }), h('span', { class: 'hint' }, 'vs fin de scène')),
    ));
  } else out.push(h('button', { onclick: () => ((s.transition_to_next = { type: 'video_overlay', file: '', duration: 1 }), rebuild()) }, '+ Transition'));

  return out;
}

function stylesPane(): HTMLElement[] {
  const out = Object.entries(project.styles).map(([name, st]) =>
    fieldset(name, [
      h('button', { class: 'small', title: 'Renommer', onclick: () => renameStyle(name) }, '✎'),
      delBtn(() => {
        if (!confirm(`Supprimer le style « ${name} » ?`)) return;
        delete project.styles[name];
        void rebuild();
      }),
    ],
      row('Police', textField(st, 'font', changed, { list: 'dl-font' })),
      row('Taille', numField(st, 'size', changed, { step: 1, min: 1 })),
      row('Couleur', h('input', { type: 'color', value: st.color, oninput: (e: Event) => ((st.color = (e.target as HTMLInputElement).value), changed()) }), textField(st, 'color', changed)),
      row('Ancrage', selectField(st, 'anchor', ['left', 'center', 'right'], changed, { optional: true })),
      row('Interligne', numField(st, 'line_height', changed, { step: 0.05, optional: true })),
      row('Largeur max', numField(st, 'max_width', changed, { step: 10, optional: true })),
    ),
  );
  out.push(h('button', { onclick: () => addStyle() }, '+ Style'));
  return out;
}

function addStyle() {
  const name = prompt('Nom du style (ex. narrative_body)')?.trim();
  if (!name || name in project.styles) return;
  project.styles[name] = { font: 'serif', size: 32, color: '#ffffff', anchor: 'center' };
  void rebuild();
}

function renameStyle(old: string) {
  const name = prompt('Nouveau nom', old)?.trim();
  if (!name || name === old || name in project.styles) return;
  project.styles = Object.fromEntries(Object.entries(project.styles).map(([k, v]) => [k === old ? name : k, v]));
  for (const sc of project.timeline) for (const tx of [...(sc.texts ?? []), ...(sc.elements ?? [])]) if ('style' in tx && tx.style === old) tx.style = name;
  void rebuild();
}

function audioPane(): HTMLElement[] {
  const g = (project.global_audio_tracks ??= []);
  return [
    h('p', { class: 'hint' }, 'Pistes jouées sur toute la vidéo (musique de fond…). Les pistes propres à une scène sont dans l’onglet Scène.'),
    ...g.map((a, i) => audioForm(a, `Piste globale ${i + 1}`, () => (g.splice(i, 1), rebuild()))),
    h('button', { onclick: () => (g.push({ file: '', start: 0, volume: 0.2, loop: true, fade_in: 2, fade_out: 3 }), rebuild()) }, '+ Piste globale'),
  ];
}

const FOLDERS = ['backgrounds', 'illustrations', 'audio', 'transitions', 'fonts'];

function mediaPane(): HTMLElement[] {
  const folder = h('select', {}, ...FOLDERS.map((f) => h('option', { value: f }, f))) as HTMLSelectElement;
  const input = h('input', { type: 'file', multiple: true }) as HTMLInputElement;
  const msg = h('div', { class: 'hint' });
  return [
    h('p', { class: 'hint' }, 'Importez vos fichiers dans le dossier assets/ du projet. Les polices sont reconnues par leur nom de fichier (Merriweather-Bold.ttf → « Merriweather-Bold »).'),
    row('Dossier', folder),
    input,
    h('button', {
      class: 'primary',
      onclick: async () => {
        for (const f of Array.from(input.files ?? [])) {
          const path = `assets/${folder.value}/${f.name}`;
          msg.textContent = `Envoi de ${f.name}…`;
          await fetch(`/api/upload?path=${encodeURIComponent(path)}`, { method: 'POST', body: f });
          media.invalidate(path);
          audio.invalidate(path);
        }
        msg.textContent = 'Terminé.';
        await refreshAssets();
        await changed();
        renderInspector();
      },
    }, 'Importer'),
    msg,
    h('fieldset', {}, h('legend', {}, `Fichiers (${assets.length})`), ...assets.map((a) => h('div', { class: 'hint' }, a))),
  ];
}

function projectPane(): HTMLElement[] {
  const p = project.project;
  return [fieldset('Projet', [],
    row('Fichier MP4', textField(p, 'output_file', changed)),
    row('FPS', numField(p, 'fps', changed, { step: 1, min: 1 })),
    row('Résolution', ...vecField(p, 'resolution', rebuild)),
    h('div', { class: 'hint' }, `Durée totale : ${fmtTime(compiled.total)}`),
  )];
}

// ---------- export ----------

$('export-btn').onclick = () => {
  const dlg = $('export-dialog');
  const crf = h('input', { type: 'number', value: 18, min: 12, max: 28 }) as HTMLInputElement;
  const body = h('div', { class: 'box' });
  dlg.replaceChildren(body);
  dlg.hidden = false;

  const showForm = () =>
    body.replaceChildren(
      h('strong', {}, 'Exporter en MP4 (H.264 + AAC)'),
      h('div', { class: 'hint' }, `${project.project.resolution.join('×')} à ${project.project.fps} fps — ${fmtTime(compiled.total)} — ${Math.round(compiled.total * project.project.fps)} images`),
      row('Qualité CRF', crf, h('span', { class: 'hint' }, '18 = très bon, 23 = standard')),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: start }, 'Lancer l’export'),
        h('button', { onclick: () => (dlg.hidden = true) }, 'Fermer'),
      ),
    );

  const start = async () => {
    await fetch('/api/project', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(project) });
    const r = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: location.origin, crf: Number(crf.value) }),
    });
    if (!r.ok) {
      body.replaceChildren(h('div', { class: 'errtext' }, JSON.stringify(await r.json())), h('button', { onclick: showForm }, 'Retour'));
      return;
    }
    poll();
  };

  const poll = async () => {
    const j = await (await fetch('/api/export')).json();
    const pct = j.total ? Math.round((j.frame / j.total) * 100) : 0;
    const warns = (j.warnings ?? []) as string[];
    const done = j.status !== 'running';
    body.replaceChildren(...[
      h('strong', {}, j.status === 'done' ? 'Export terminé' : j.status === 'error' ? 'Échec de l’export' : j.status === 'cancelled' ? 'Export annulé' : `Export en cours… ${pct}%`),
      h('progress', { max: j.total || 1, value: j.frame ?? 0 }),
      j.error ? h('div', { class: 'errtext' }, j.error) : null,
      warns.length ? h('div', { class: 'warn' }, ...warns.map((w) => h('div', {}, '⚠ ' + w))) : null,
      h('div', { class: 'row' },
        j.status === 'done' ? h('a', { href: `/exports/${encodeURIComponent(j.output)}`, download: j.output }, h('button', { class: 'primary' }, 'Télécharger')) : null,
        done ? h('button', { onclick: () => (dlg.hidden = true) }, 'Fermer') : h('button', { class: 'danger', onclick: () => fetch('/api/export/cancel', { method: 'POST' }) }, 'Annuler'),
      ),
    ].filter((x): x is HTMLElement => x != null));
    if (!done) setTimeout(poll, 700);
  };

  showForm();
};

// ---------- démarrage ----------

(async () => {
  project = await (await fetch('/api/project')).json();
  compiled = compile(project);
  await refreshAssets();
  await changed();
  renderInspector();
  setStatus('Chargé');
})();
