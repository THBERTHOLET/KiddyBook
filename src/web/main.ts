import { compile, sceneAt, type Compiled, type Durations, type Layer } from '../shared/compile';
import { Media } from '../shared/media';
import { layoutText, renderFrame } from '../shared/render';
import { audioFor, outputName, ProjectSchema, resolveStyle, TEXT_OVERRIDES, type Project, type Scene } from '../shared/schema';
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

/**
 * JSON enregistré : copie du projet sans les objets d'effets vides (le formulaire en crée pour pouvoir
 * y écrire ; on ne les retire qu'à l'enregistrement pour ne pas détacher les champs encore affichés).
 */
function serialize(): string {
  const clone = JSON.parse(JSON.stringify(project)) as Project;
  if (clone.ducking && !Object.keys(clone.ducking).length) delete clone.ducking;
  for (const sc of clone.timeline) {
    for (const el of sc.elements ?? []) {
      const fx = (el as any).effects;
      if (!fx) continue;
      for (const k of ['shadow', 'border']) if (fx[k] && !Object.keys(fx[k]).length) delete fx[k];
      if (!Object.keys(fx).length) delete (el as any).effects;
    }
  }
  return JSON.stringify(clone);
}

/**
 * Projet que cet onglet affiche (renvoyé avec les données au chargement). Il accompagne chaque écriture :
 * le serveur refuse si un autre projet est entre-temps devenu le projet ouvert.
 */
let currentProject = '';
const writeHeaders = (extra: Record<string, string> = {}) => ({ 'X-Project': currentProject, ...extra });

/** Onglet désynchronisé : on arrête d'écrire et on le dit clairement. */
function desynced(message: string) {
  clearTimeout(saveTimer);
  setStatus(`⚠ ${message}`, true);
}

let saveTimer: number | undefined;
function scheduleSave() {
  setStatus('Modifié…');
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    const r = await fetch('/api/project', {
      method: 'PUT',
      headers: writeHeaders({ 'Content-Type': 'application/json' }),
      body: serialize(),
    });
    if (r.ok) setStatus('Enregistré');
    else if (r.status === 409) desynced((await r.json()).error);
    else {
      const { errors } = await r.json();
      setStatus(`Non enregistré : ${errors[0].path} — ${errors[0].message}`, true);
    }
  }, 600);
}

/** Durées des fichiers audio (ffprobe côté serveur) : nécessaires aux durées automatiques et aux synchros. */
let audioDur: Durations = {};
/** Langue affichée dans l'aperçu (la première de `project.languages` par défaut). */
let lang = '';
const activeLang = (): string | undefined => {
  const ls = project?.languages ?? [];
  return ls.includes(lang) ? lang : ls[0];
};
const compileNow = () => compile(project, audioDur, activeLang());

/** Sélecteur de langue de l'en-tête : visible seulement si le projet déclare des langues. */
function initLangSelect() {
  const sel = $<HTMLSelectElement>('lang-select');
  const ls = project.languages ?? [];
  sel.hidden = ls.length === 0;
  sel.replaceChildren(...ls.map((l, i) => h('option', { value: l }, i === 0 ? `${l} (défaut)` : l)));
  sel.value = activeLang() ?? '';
  sel.onchange = () => {
    lang = sel.value;
    void rebuild();
  };
}

async function refreshAssets() {
  assets = await (await fetch('/api/assets')).json();
  audioDur = await (await fetch('/api/audio-durations')).json();
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
  compiled = compileNow();
  fitViewport();
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
let pendingDraw: boolean | null = null; // image demandée pendant un rendu en cours (valeur = exact)
async function draw(exact = true) {
  if (drawing) {
    pendingDraw = exact || !!pendingDraw;
    return;
  }
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
  drawOverlay();
  $('time').textContent = `${fmtTime(t)} / ${fmtTime(compiled.total)}`;
  const head = document.querySelector<HTMLElement>('#timeline .head');
  if (head) head.style.left = `${(t / compiled.total) * 100}%`;
  if (pendingDraw !== null) {
    const again = pendingDraw;
    pendingDraw = null;
    await draw(again);
  }
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
  void audio.start(compiled.audio, t, compiled.duck);
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
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'Space') {
    e.preventDefault();
    $('play').click();
  } else if (e.code === 'Escape') {
    audio.stop(); // arrête aussi une écoute de passage
    selectRef(null, false);
  } else if (e.code.startsWith('Arrow') && selRef?.position) {
    // flèches : déplacement fin de la sélection (Maj = 10 px)
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    const [x, y] = selRef.position as [number, number];
    selRef.position = [x + (e.code === 'ArrowRight' ? d : e.code === 'ArrowLeft' ? -d : 0), y + (e.code === 'ArrowDown' ? d : e.code === 'ArrowUp' ? -d : 0)];
    void changed().then(() => tab === 'scene' && renderInspector());
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
            renderSceneList();
            void seek(compiled.scenes[i].start);
            renderInspector();
          },
        },
        h('span', { class: 'name' }, `${i + 1}. ${sceneLabel(s, i)}`),
        h('span', { class: 'dur' }, `${+compiled.scenes[i].duration.toFixed(1)}s${s.auto_duration ? ' auto' : ''}`),
      ),
    ),
    h(
      'div',
      { class: 'add-row' },
      h('button', { onclick: () => addScene('page') }, '+ Page'),
      h('button', { onclick: () => addScene('cover') }, '+ Couv.'),
      h('button', { onclick: () => addScene('end') }, '+ Fin'),
      h('button', { title: 'Dupliquer la scène sélectionnée (juste après elle)', onclick: duplicateScene }, '⧉ Dupliquer'),
    ),
  );
}

/** Copie la scène sélectionnée juste après elle, avec tous ses éléments, textes et audios. */
function duplicateScene() {
  const copy: Scene = structuredClone(project.timeline[selScene]);
  if (copy.type === 'page') {
    const nums = project.timeline.map((s) => s.page_index ?? 0);
    copy.page_index = Math.max(0, ...nums) + 1;
  }
  project.timeline.splice(selScene + 1, 0, copy);
  selScene += 1;
  tab = 'scene';
  void rebuild().then(() => seek(compiled.scenes[selScene].start));
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

/** Sections repliées, par objet du projet (survit aux reconstructions de l'inspecteur). */
const collapsed = new WeakSet<object>();

type Head = string | { key: object; title: string; rename?: boolean };

/** Double-clic sur un libellé : l'édite. Vide ou identique au nom par défaut = retour au nom par défaut. */
function editLabel(label: HTMLElement, o: any, def: string) {
  const input = h('input', { type: 'text', value: o.name ?? def, class: 'sec-edit' }) as HTMLInputElement;
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit: boolean) => {
    if (done) return;
    done = true;
    if (commit) {
      const v = input.value.trim();
      if (!v || v === def) delete o.name;
      else o.name = v;
    }
    label.textContent = o.name ?? def;
    input.replaceWith(label);
    if (commit) void changed();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

/** Section d'inspecteur. Avec un `key`, elle est repliable ; avec `rename`, son titre se renomme au double-clic. */
const fieldset = (head: Head, extra: (Node | null)[], ...rows: HTMLElement[]) => {
  if (typeof head === 'string') return h('fieldset', {}, h('legend', {}, head, ...extra), ...rows);
  const { key, title, rename } = head;
  const fs = h('fieldset', { class: collapsed.has(key) ? 'collapsed' : '' });
  const chevron = h('button', { class: 'small chevron', title: 'Replier / déplier' }, collapsed.has(key) ? '▸' : '▾');
  chevron.addEventListener('click', () => {
    const now = !collapsed.has(key);
    now ? collapsed.add(key) : collapsed.delete(key);
    fs.classList.toggle('collapsed', now);
    chevron.textContent = now ? '▸' : '▾';
  });
  const label = h('span', { class: 'sec-title', title: rename ? 'Double-clic pour renommer' : undefined }, (key as any).name ?? title);
  if (rename) label.addEventListener('dblclick', () => editLabel(label, key, title));
  fs.append(h('legend', {}, chevron, label, ...extra), h('div', { class: 'sec-body' }, ...rows));
  return fs;
};

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

const PRESETS: Record<string, any> = {
  'Bords adoucis': { feather: 60 },
  'Ombre portée': { shadow: { color: 'rgba(0,0,0,0.55)', blur: 30, x: 0, y: 14 } },
  'Coins arrondis + ombre': { corner_radius: 48, shadow: { color: 'rgba(0,0,0,0.5)', blur: 28, x: 0, y: 12 } },
  'Cadre photo': { rotation: -2, border: { color: '#fffaf0', width: 18 }, shadow: { color: 'rgba(0,0,0,0.5)', blur: 30, x: 8, y: 14 } },
  'Cadre doré': { border: { color: '#c9a227', width: 14, style: 'double' }, shadow: { color: 'rgba(0,0,0,0.5)', blur: 24, x: 0, y: 10 } },
  'Halo lumineux': { corner_radius: 30, shadow: { color: '#ffd27a', blur: 70, x: 0, y: 0 } },
};

const openEffects = new WeakSet<object>();

/** Couleur : sélecteur + texte libre (rgba(), noms…). */
function colorRow(label: string, o: any, key: string, def: string, notify: () => unknown = changed) {
  const val = () => String(o[key] ?? def);
  const text = textField(o, key, notify as () => void, { optional: true }) as HTMLInputElement;
  text.placeholder = def;
  const pick = h('input', {
    type: 'color',
    value: /^#[0-9a-f]{6}$/i.test(val()) ? val() : '#000000',
    oninput: (e: Event) => {
      o[key] = (e.target as HTMLInputElement).value;
      text.value = o[key];
      void notify();
    },
  });
  return row(label, pick, text);
}

/** Effets d'une image / vidéo : préréglages + réglages fins. */
function effectsForm(o: any): HTMLElement {
  const fx = (o.effects ??= {});
  const sh = (fx.shadow ??= {});
  const bd = (fx.border ??= {});

  // Forme canonique des effets (objets vides retirés, clés triées) pour reconnaître un préréglage.
  const canon = (e: any): string => {
    const c = JSON.parse(JSON.stringify(e ?? {}));
    for (const k of ['shadow', 'border']) if (c[k] && !Object.keys(c[k]).length) delete c[k];
    const sort = (v: any): any =>
      Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
    return JSON.stringify(sort(c));
  };
  /** Préréglage correspondant aux effets actuels : aucun, l'un des préréglages, ou personnalisé. */
  const current = () => {
    const c = canon(fx);
    return c === '{}' ? '__none' : Object.keys(PRESETS).find((p) => canon(PRESETS[p]) === c) ?? '__custom';
  };
  const active = current() !== '__none';

  const preset = h('select', {
    onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      if (v === '__custom') return;
      o.effects = v === '__none' ? {} : structuredClone(PRESETS[v]);
      openEffects.add(o);
      void rebuild();
    },
  },
    h('option', { value: '__none' }, 'Aucun effet'),
    ...Object.keys(PRESETS).map((p) => h('option', { value: p }, p)),
    h('option', { value: '__custom', disabled: true }, 'Personnalisé'),
  ) as HTMLSelectElement;
  preset.value = current();

  // Toute retouche fine remet le menu à jour (préréglage reconnu, ou « Personnalisé »).
  const touch = () => {
    preset.value = current();
    summary.textContent = current() === '__none' ? 'Effets' : 'Effets ●';
    return changed();
  };
  const summary = h('summary', {}, active ? 'Effets ●' : 'Effets');

  const d = h('details', { class: 'effects' },
    summary,
    row('Préréglage', preset),
    row('Opacité', numField(fx, 'opacity', touch, { min: 0, step: 0.05, optional: true })),
    row('Rotation °', numField(fx, 'rotation', touch, { step: 0.5, optional: true })),
    row('Coins arrondis', numField(fx, 'corner_radius', touch, { min: 0, step: 4, optional: true })),
    row('Bords fondus', numField(fx, 'feather', touch, { min: 0, step: 5, optional: true })),
    h('div', { class: 'hint' }, 'Ombre'),
    row('Flou', numField(sh, 'blur', touch, { min: 0, step: 2, optional: true })),
    row('Décalage', numField(sh, 'x', touch, { step: 2, optional: true }), numField(sh, 'y', touch, { step: 2, optional: true })),
    colorRow('Couleur', sh, 'color', 'rgba(0,0,0,0.6)', touch),
    h('div', { class: 'hint' }, 'Bordure / cadre'),
    row('Épaisseur', numField(bd, 'width', touch, { min: 0, step: 1, optional: true }), selectField(bd, 'style', ['solid', 'double'], touch, { optional: true })),
    colorRow('Couleur', bd, 'color', '#ffffff', touch),
  ) as HTMLDetailsElement;
  d.open = active || openEffects.has(o);
  d.addEventListener('toggle', () => (d.open ? openEffects.add(o) : openEffects.delete(o)));
  return d;
}

/** Synchronise un texte sur un passage audio de la scène : il apparaît et disparaît avec lui. */
function syncRows(o: any): HTMLElement[] {
  const clips = (project.timeline[selScene].audio ?? []).map((a, i) => ({ a, i }));
  const sel = h('select', {
    onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      if (v === '') delete o.sync;
      else {
        const a = clips[Number(v)].a;
        a.id ??= 'a' + Math.random().toString(36).slice(2, 8); // identifiant stable, créé à la demande
        o.sync = a.id;
      }
      void rebuild();
    },
  },
    h('option', { value: '' }, '— manuel'),
    ...clips.map(({ a, i }) => h('option', { value: String(i) }, `${a.name ?? `Audio ${i + 1}`} (${ROLE_LABELS[a.role ?? 'sfx']})`)),
  ) as HTMLSelectElement;
  const idx = clips.findIndex(({ a }) => a.id && a.id === o.sync);
  sel.value = idx >= 0 ? String(idx) : '';
  const rows = [row('Synchro audio', sel)];
  if (idx >= 0) rows.push(h('div', { class: 'hint' }, 'Apparaît au début du passage et disparaît à sa fin. « Début » = décalage ; « Durée » vide = jusqu’à la fin du passage.'));
  else if (o.sync) rows.push(h('div', { class: 'errtext' }, 'Le passage audio synchronisé n’existe plus : le texte est en mode manuel.'));
  return rows;
}

/** Formulaire d'une couche, lié à la sélection sur le canvas. */
function layerForm(o: any, kind: 'text' | 'image' | 'video', title: string, onDelete?: () => void, onMove?: (d: number) => void) {
  const fs = buildLayerForm(o, kind, title, onDelete, onMove);
  (fs as any)._ref = o;
  fs.addEventListener('focusin', () => selectRef(o, false));
  if (o === selRef) fs.classList.add('selected');
  return fs;
}

function naturalOf(file: string, kind: 'image' | 'video'): [number, number] {
  const src = kind === 'image' ? media.images.get(file) : media.videos.get(file);
  if (src instanceof HTMLVideoElement) return [src.videoWidth, src.videoHeight];
  return src ? [src.naturalWidth, src.naturalHeight] : [0, 0];
}

let pctBase: 'orig' | 'w' | 'h' = 'orig';

/** Boutons et champ % pour dimensionner une image / vidéo en gardant ses proportions. */
function sizeHelpers(o: any, kind: 'image' | 'video'): HTMLElement[] {
  const [W, H] = project.project.resolution;
  const [nw, nh] = naturalOf(o.file, kind);
  const known = nw > 0 && nh > 0;
  const cur: [number, number] = o.size ?? (known ? [nw, nh] : [400, 300]);
  const place = (x: number, y: number, w: number, h: number) => {
    o.position = [Math.round(x), Math.round(y)];
    o.size = [Math.round(w), Math.round(h)];
    void rebuild();
  };
  const fit = (cover: boolean) => () => {
    const s = (cover ? Math.max : Math.min)(W / nw, H / nh);
    place((W - nw * s) / 2, (H - nh * s) / 2, nw * s, nh * s);
  };
  const btn = (label: string, title: string, fn: () => void, needsSize = false) =>
    h('button', { class: 'small', title, disabled: needsSize && !known, onclick: fn }, label);

  const refW = () => (pctBase === 'orig' ? nw : pctBase === 'w' ? W : H * (nw / nh));
  const pctVal = known ? Math.round((cur[0] / refW()) * 1000) / 10 : '';
  const pct = h('input', {
    type: 'number', step: 5, min: 1, value: pctVal, disabled: !known,
    onchange: (e: Event) => {
      const p = Number((e.target as HTMLInputElement).value);
      if (!(p > 0)) return;
      const w = (refW() * p) / 100;
      const hh = w * (nh / nw);
      const cx = o.position[0] + cur[0] / 2;
      const cy = o.position[1] + cur[1] / 2;
      place(cx - w / 2, cy - hh / 2, w, hh); // recentré sur l'ancien centre
    },
  });
  const base = h('select', {
    onchange: (e: Event) => {
      pctBase = (e.target as HTMLSelectElement).value as typeof pctBase;
      void rebuild();
    },
  },
    h('option', { value: 'orig' }, 'de l’original'),
    h('option', { value: 'w' }, 'de la largeur écran'),
    h('option', { value: 'h' }, 'de la hauteur écran'),
  ) as HTMLSelectElement;
  base.value = pctBase;

  return [
    h('div', { class: 'btnrow' },
      btn('Étirer plein écran', 'Remplit tout l’écran, proportions ignorées', () => place(0, 0, W, H)),
      btn('Ajuster', 'Tient entièrement dans l’écran, proportions gardées', fit(false), true),
      btn('Remplir', 'Couvre tout l’écran, proportions gardées (rogne)', fit(true), true),
      btn('Centrer', 'Centre sans changer la taille', () => {
        o.position = [Math.round((W - cur[0]) / 2), Math.round((H - cur[1]) / 2)];
        void rebuild();
      }),
      btn('Original', 'Taille d’origine du fichier', () => { delete o.size; void rebuild(); }, true),
    ),
    row('Échelle %', pct, base),
  ];
}

/** Texte du paragraphe : une zone par langue si le projet en déclare, sinon une seule. */
function contentFields(o: any): HTMLElement[] {
  const ls = project.languages ?? (typeof o.content === 'string' ? [] : Object.keys(o.content));
  if (!ls.length) return [areaField(o, 'content', changed)];
  return ls.map((l) => {
    const get = () => (typeof o.content === 'string' ? (l === ls[0] ? o.content : '') : (o.content[l] ?? ''));
    const area = h('textarea', {
      placeholder: l === ls[0] ? '' : 'à traduire (sinon : texte de la langue par défaut)',
      oninput: () => {
        const v = area.value;
        if (typeof o.content === 'string') {
          if (l === ls[0]) o.content = v;
          else o.content = { [ls[0]]: o.content, [l]: v };
        } else if (v === '' && l !== ls[0]) delete o.content[l];
        else o.content[l] = v;
        void changed();
      },
    }) as HTMLTextAreaElement;
    area.value = get();
    return row(l === activeLang() ? `▸ ${l}` : l, area);
  });
}

/** Liste « oui / non / comme le style » pour un booléen surchargeable. */
function triState(o: any, k: 'bold' | 'italic', inherited: boolean) {
  const sel = h('select', {
    onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      if (v === '') delete o[k];
      else o[k] = v === '1';
      void rebuild();
    },
  },
    h('option', { value: '' }, `comme le style (${inherited ? 'oui' : 'non'})`),
    h('option', { value: '1' }, 'oui'),
    h('option', { value: '0' }, 'non'),
  ) as HTMLSelectElement;
  sel.value = o[k] == null ? '' : o[k] ? '1' : '0';
  return sel;
}

/** Surcharges du style pour un texte : taille, couleur, gras… Les champs vides héritent du style. */
function textOverrideRows(o: any): HTMLElement[] {
  const st = project.styles[o.style];
  if (!st) return [];
  const eff = resolveStyle(st, {});
  const ph = (el: HTMLElement, v: unknown) => Object.assign(el, { placeholder: String(v ?? '') });
  const colorHex = /^#[0-9a-f]{6}$/i.test(o.color ?? eff.color) ? (o.color ?? eff.color) : '#ffffff';
  const used = TEXT_OVERRIDES.some((k) => o[k] !== undefined);
  return [
    row('Police', ph(textField(o, 'font', changed, { list: 'dl-font', optional: true, folder: 'fonts' }), eff.font)),
    row('Taille', ph(numField(o, 'size', changed, { step: 1, min: 1, optional: true }), eff.size)),
    row('Couleur',
      h('input', { type: 'color', value: colorHex, oninput: (e: Event) => { o.color = (e.target as HTMLInputElement).value; changed(); } }),
      ph(textField(o, 'color', changed, { optional: true }), eff.color)),
    row('Gras', triState(o, 'bold', !!eff.bold)),
    row('Italique', triState(o, 'italic', !!eff.italic)),
    row('Ancrage', ph(selectField(o, 'anchor', ['left', 'center', 'right'], changed, { optional: true }), eff.anchor ?? 'center')),
    row('Interligne', ph(numField(o, 'line_height', changed, { step: 0.05, optional: true }), eff.line_height ?? 1.3)),
    used ? h('button', { class: 'small', title: 'Revenir au style', onclick: () => { for (const k of TEXT_OVERRIDES) delete o[k]; void rebuild(); } }, '↺ Retirer les surcharges') : h('div', { class: 'hint' }, 'Champs vides = valeurs du style.'),
  ];
}

function buildLayerForm(o: any, kind: 'text' | 'image' | 'video', title: string, onDelete?: () => void, onMove?: (d: number) => void) {
  const extra = [
    ...(onMove ? [h('button', { class: 'small', title: 'Monter dans la liste (plus au fond)', onclick: () => onMove(-1) }, '↑'), h('button', { class: 'small', title: 'Descendre dans la liste (plus devant)', onclick: () => onMove(1) }, '↓')] : []),
    ...(onDelete ? [delBtn(onDelete)] : []),
  ];
  if (kind === 'text') {
    return fieldset({ key: o, title, rename: true }, extra,
      row('Style', selectField(o, 'style', Object.keys(project.styles), rebuild)),
      ...contentFields(o),
      row('Position', ...vecField(o, 'position', changed)),
      row('Largeur', numField(o, 'width', changed, { step: 10, min: 10, optional: true }), h('span', { class: 'hint' }, 'vide = auto · retour à la ligne')),
      ...textOverrideRows(o),
      ...syncRows(o),
      ...timingRows(o),
    );
  }
  return fieldset({ key: o, title, rename: true }, extra,
    row('Fichier', textField(o, 'file', changed, { list: kind === 'image' ? 'dl-img' : 'dl-video', folder: 'illustrations' })),
    row('Position', ...vecField(o, 'position', changed)),
    row('Taille', ...vecField(o, 'size', changed, { optional: true })),
    ...sizeHelpers(o, kind),
    effectsForm(o),
    ...timingRows(o),
  );
}

/** Écoute un passage audio seul, avec son offset, sa durée et ses fondus. */
async function audition(orig: any) {
  const a = audioFor(orig, activeLang());
  if (!a.file) return;
  pause();
  await audio.preload([a.file], (f) => media.url(f));
  await audio.start([{
    file: a.file, role: a.role ?? 'sfx', start: 0, duration: a.duration ?? (a.loop ? 10 : undefined), volume: a.volume ?? 1,
    loop: !!a.loop, fadeIn: a.fade_in ?? 0, fadeOut: a.fade_out ?? 0, offset: a.offset ?? 0,
  }], 0);
}

const ROLE_LABELS: Record<string, string> = { narration: 'Narration', music: 'Musique', sfx: 'Effet sonore' };

/** Type d'un passage audio. Narration : atténue la musique et fixe la durée automatique de la scène. */
function roleSelect(o: any, def: 'music' | 'sfx') {
  const sel = h('select', {
    onchange: (e: Event) => {
      o.role = (e.target as HTMLSelectElement).value;
      void rebuild(); // les listes de synchro et la durée de la scène en dépendent
    },
  }, ...Object.entries(ROLE_LABELS).map(([v, label]) => h('option', { value: v }, label))) as HTMLSelectElement;
  sel.value = o.role ?? def;
  return sel;
}

function audioForm(o: any, title: string, onDelete: () => void, defaultRole: 'music' | 'sfx' = 'sfx') {
  const len = o.duration ?? (audioDur[o.file] != null ? audioDur[o.file] - (o.offset ?? 0) : undefined);
  return fieldset({ key: o, title, rename: true }, [h('button', { class: 'small', title: 'Écouter ce passage seul (Échap pour arrêter)', onclick: () => audition(o) }, '▶'), delBtn(onDelete)],
    row('Fichier', textField(o, 'file', changed, { list: 'dl-audio', folder: 'audio' })),
    row('Type', roleSelect(o, defaultRole)),
    row('Début (s)', numField(o, 'start', changed, { min: 0, optional: true }), h('span', { class: 'hint' }, 'dans la scène')),
    row('Lire dès (s)', numField(o, 'offset', changed, { min: 0, step: 0.1, optional: true }), h('span', { class: 'hint' }, 'dans le fichier')),
    row('Durée (s)', Object.assign(numField(o, 'duration', changed, { min: 0.1, optional: true }), { placeholder: len != null ? len.toFixed(1) : '' }), h('span', { class: 'hint' }, len != null ? 'vide = jusqu’à la fin du fichier' : '')),
    row('Volume', numField(o, 'volume', changed, { min: 0, step: 0.05, optional: true })),
    row('Fondu', numField(o, 'fade_in', changed, { min: 0, optional: true }), h('span', { class: 'hint' }, 'in'), numField(o, 'fade_out', changed, { min: 0, optional: true }), h('span', { class: 'hint' }, 'out')),
    row('Boucle', checkField(o, 'loop', changed)),
    ...variantRows(o),
  );
}

/** Fichier, point de départ et durée propres à chaque langue (sauf la langue par défaut, qui utilise les champs de base). */
function variantRows(o: any): HTMLElement[] {
  const others = (project.languages ?? []).slice(1);
  if (!others.length) return [];
  const rows: HTMLElement[] = [h('div', { class: 'hint' }, `Les champs ci-dessus sont ceux de « ${project.languages![0]} ». Autres langues :`)];
  for (const l of others) {
    // l'objet n'est rattaché à `o.variants` que s'il contient quelque chose : pas de variantes vides dans le projet
    const v: Record<string, any> = { ...(o.variants?.[l] ?? {}) };
    const commit = () => {
      for (const k of Object.keys(v)) if (v[k] === undefined) delete v[k];
      if (Object.keys(v).length) (o.variants ??= {})[l] = v;
      else if (o.variants) {
        delete o.variants[l];
        if (!Object.keys(o.variants).length) delete o.variants;
      }
      void changed();
    };
    const len = v.duration ?? (v.file && audioDur[v.file] != null ? audioDur[v.file] - (v.offset ?? 0) : undefined);
    rows.push(
      row(`Fichier ${l}`, textField(v, 'file', commit, { list: 'dl-audio', optional: true, folder: 'audio' })),
      row(`Lire dès ${l}`, numField(v, 'offset', commit, { min: 0, optional: true }), h('span', { class: 'hint' }, 's')),
      row(`Durée ${l}`, Object.assign(numField(v, 'duration', commit, { min: 0.1, optional: true }), { placeholder: len != null ? len.toFixed(1) : '' }), h('span', { class: 'hint' }, 's')),
    );
  }
  return rows;
}

function scenePane(): HTMLElement[] {
  const s = project.timeline[selScene];
  const tl = project.timeline;
  const defaultPos = (): [number, number] => [project.project.resolution[0] / 2, project.project.resolution[1] * 0.85];
  const firstStyle = Object.keys(project.styles)[0] ?? '';

  const sections = () => [s, s.illustration, ...(s.elements ?? []), ...(s.texts ?? []), ...(s.audio ?? []), s.transition_to_next].filter(Boolean) as object[];
  const foldAll = (fold: boolean) => () => {
    for (const k of sections()) fold ? collapsed.add(k) : collapsed.delete(k);
    renderInspector();
  };

  const out: HTMLElement[] = [
    h('div', { class: 'btnrow' },
      h('button', { class: 'small', onclick: foldAll(true) }, '▸ Tout replier'),
      h('button', { class: 'small', onclick: foldAll(false) }, '▾ Tout déplier'),
      h('span', { class: 'hint' }, 'Double-clic sur un titre pour le renommer'),
    ),
    fieldset({ key: s, title: `Scène ${selScene + 1}` }, [
      h('button', { class: 'small', onclick: () => moveItem(tl, selScene, -1) && (selScene--, rebuild()) }, '↑'),
      h('button', { class: 'small', onclick: () => moveItem(tl, selScene, 1) && (selScene++, rebuild()) }, '↓'),
      h('button', { class: 'small', title: 'Dupliquer', onclick: duplicateScene }, '⧉'),
      tl.length > 1 ? delBtn(() => (tl.splice(selScene, 1), (selScene = Math.max(0, selScene - 1)), rebuild())) : null,
    ],
      row('Type', selectField(s, 'type', ['cover', 'page', 'end'], rebuild)),
      row('N° de page', numField(s, 'page_index', changed, { step: 1, optional: true })),
      row('Fond', textField(s, 'background', changed, { list: 'dl-img', optional: true, folder: 'backgrounds' })),
      row('Durée (s)', numField(s, 'duration', changed, { min: 0.5 }),
        h('span', { class: 'hint' }, s.auto_duration ? `auto : ${compiled.scenes[selScene].duration.toFixed(1)} s` : '')),
      row('Durée auto', checkField(s, 'auto_duration', rebuild), numField(s, 'end_pad', changed, { min: 0, step: 0.1, optional: true }),
        h('span', { class: 'hint' }, 's de marge (déf. 1)')),
      s.auto_duration && !(s.audio ?? []).some((a) => a.role === 'narration')
        ? h('div', { class: 'hint' }, 'Aucun passage de type Narration dans cette scène : la durée manuelle est utilisée.')
        : h('div', { class: 'hint' }, 'Durée auto = fin de la dernière narration + marge.'),
      row('Fondu', numField(s, 'fade_in', changed, { min: 0, optional: true }), h('span', { class: 'hint' }, 'in'), numField(s, 'fade_out', changed, { min: 0, optional: true }), h('span', { class: 'hint' }, 'out')),
    ),
  ];

  // illustration
  // `illustration` est la première image de la scène ; les suivantes sont des éléments de type image.
  // Images, vidéos et textes libres : un seul empilement, le premier de la liste est au fond.
  const count = { image: 0, video: 0, text: 0 };
  out.push(h('div', { class: 'hint' }, 'Ordre d’empilement : le premier de la liste est au fond (↑ vers le fond, ↓ vers l’avant).'));
  (s.elements ??= []).forEach((e, i) => {
    const kind = 'file' in e ? (e.type === 'video' ? 'video' : 'image') : 'text';
    const label = { image: 'Illustration', video: 'Vidéo', text: 'Texte' }[kind];
    out.push(layerForm(e, kind, `${label} ${++count[kind]}`, () => (s.elements!.splice(i, 1), rebuild()), (d) => moveItem(s.elements!, i, d) && rebuild()));
  });

  const addIllustration = () => {
    const n = count.image; // décale légèrement chaque nouvelle image pour qu'elles ne se superposent pas
    const img = { type: 'image' as const, file: '', position: [460 + 40 * n, 140 + 40 * n] as [number, number], size: [1000, 640] as [number, number], start: 0.3, fade_in: 0.5 };
    s.elements!.push(img);
    selRef = img;
    void rebuild();
  };

  // textes
  (s.texts ??= []).forEach((e, i) =>
    out.push(layerForm(e, 'text', `Texte ${i + 1}`, () => (s.texts!.splice(i, 1), rebuild()), (d) => moveItem(s.texts!, i, d) && rebuild())),
  );
  out.push(
    h('div', { class: 'btnrow' },
      h('button', { onclick: addIllustration }, '+ Illustration'),
      h('button', { onclick: () => (s.texts!.push({ style: firstStyle, content: 'Nouveau texte', position: defaultPos(), start: 0.5, fade_in: 0.5 }), rebuild()) }, '+ Texte'),
      h('button', { onclick: () => (s.elements!.push({ type: 'video', file: '', position: [0, 0], size: project.project.resolution }), rebuild()) }, '+ Vidéo'),
    ),
  );

  // audio
  (s.audio ??= []).forEach((a, i) => out.push(audioForm(a, `Audio ${i + 1}`, () => (s.audio!.splice(i, 1), rebuild()), 'sfx')));
  out.push(h('button', { onclick: () => (s.audio!.push({ file: '', start: 0, volume: 1 }), rebuild()) }, '+ Piste audio'));

  // transition
  if (s.transition_to_next) {
    const tr = s.transition_to_next;
    out.push(fieldset({ key: tr, title: 'Transition vers la suivante' }, [delBtn(() => (delete s.transition_to_next, rebuild()))],
      row('Vidéo', textField(tr, 'file', changed, { list: 'dl-video', folder: 'transitions' })),
      row('Durée (s)', numField(tr, 'duration', changed, { min: 0.1 })),
      row('Décalage', numField(tr, 'offset', changed, { optional: true }), h('span', { class: 'hint' }, 'vs fin de scène')),
    ));
  } else out.push(h('button', { onclick: () => ((s.transition_to_next = { type: 'video_overlay', file: '', duration: 1 }), rebuild()) }, '+ Transition'));

  return out;
}

function stylesPane(): HTMLElement[] {
  const out = Object.entries(project.styles).map(([name, st]) =>
    fieldset({ key: st, title: name }, [
      h('button', { class: 'small', title: 'Renommer', onclick: () => renameStyle(name) }, '✎'),
      delBtn(() => {
        if (!confirm(`Supprimer le style « ${name} » ?`)) return;
        delete project.styles[name];
        void rebuild();
      }),
    ],
      row('Police', textField(st, 'font', changed, { list: 'dl-font', folder: 'fonts' })),
      row('Taille', numField(st, 'size', changed, { step: 1, min: 1 })),
      row('Couleur', h('input', { type: 'color', value: st.color, oninput: (e: Event) => ((st.color = (e.target as HTMLInputElement).value), changed()) }), textField(st, 'color', changed)),
      row('Gras', checkField(st, 'bold', changed), h('span', { class: 'hint' }, 'Italique'), checkField(st, 'italic', changed)),
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
  const dk = (project.ducking ??= {});
  return [
    fieldset('Atténuation de la musique', [],
      row('Activer', checkField(dk, 'enabled', rebuild)),
      row('Réduction (dB)', numField(dk, 'level_db', changed, { max: 0, step: 1, optional: true }), h('span', { class: 'hint' }, 'déf. −12')),
      row('Descente (s)', numField(dk, 'attack', changed, { min: 0, step: 0.1, optional: true }), h('span', { class: 'hint' }, 'avant la narration')),
      row('Remontée (s)', numField(dk, 'release', changed, { min: 0, step: 0.1, optional: true }), h('span', { class: 'hint' }, 'après la narration')),
      h('div', { class: 'hint' }, 'Les pistes de type Musique baissent pendant chaque passage de type Narration.'),
    ),
    h('p', { class: 'hint' }, 'Pistes jouées sur toute la vidéo (musique de fond…). Les pistes propres à une scène sont dans l’onglet Scène.'),
    ...g.map((a, i) => audioForm(a, `Piste globale ${i + 1}`, () => (g.splice(i, 1), rebuild()), 'music')),
    h('button', { onclick: () => (g.push({ file: '', start: 0, volume: 0.2, loop: true, fade_in: 2, fade_out: 3 }), rebuild()) }, '+ Piste globale'),
  ];
}

const FOLDERS = ['backgrounds', 'illustrations', 'audio', 'transitions', 'fonts'];

function mediaPane(): HTMLElement[] {
  const folder = h('select', {}, h('option', { value: '' }, 'automatique (selon le type)'), ...FOLDERS.map((f) => h('option', { value: f }, f))) as HTMLSelectElement;
  const input = h('input', { type: 'file', multiple: true }) as HTMLInputElement;
  const msg = h('div', { class: 'hint' });

  const importFiles = async (files: File[]) => {
    for (const f of files) {
      const k = kindOf(f.name);
      if (!k) {
        msg.textContent = `Type non géré : ${f.name}`;
        continue;
      }
      msg.textContent = `Envoi de ${f.name}…`;
      await uploadFile(f, folder.value || defaultFolder(k));
    }
    msg.textContent = 'Terminé.';
    await refreshAssets();
    await changed();
    renderInspector();
  };

  const zone = h('div', { class: 'dropzone' }, 'Déposez vos fichiers ici (images, vidéos, audio, polices)');
  zone.addEventListener('dragover', (e) => (e.preventDefault(), zone.classList.add('over')));
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    void importFiles(Array.from((e as DragEvent).dataTransfer?.files ?? []));
  });

  return [
    h('p', { class: 'hint' }, 'Les fichiers vont dans assets/ du projet. Vous pouvez aussi les déposer directement sur l’aperçu ou sur un champ « Fichier ». Les polices sont reconnues par leur nom de fichier (Merriweather-Bold.ttf → « Merriweather-Bold »).'),
    zone,
    row('Dossier', folder),
    input,
    h('button', { class: 'primary', onclick: () => importFiles(Array.from(input.files ?? [])) }, 'Importer'),
    msg,
    h('fieldset', {}, h('legend', {}, `Fichiers (${assets.length})`),
      h('div', { class: 'hint' }, 'Glissez un fichier vers l’aperçu ou un champ.'),
      ...assets.map((a) => {
        const d = h('div', { class: 'hint asset', draggable: true }, a);
        d.addEventListener('dragstart', (e) => (e as DragEvent).dataTransfer?.setData('text/asset', a));
        return d;
      })),
  ];
}

function projectPane(): HTMLElement[] {
  const p = project.project;
  return [fieldset('Projet', [],
    row('Fichier MP4', textField(p, 'output_file', changed)),
    row('Langues', h('input', {
      type: 'text',
      value: (project.languages ?? []).join(', '),
      placeholder: 'ex. fr, en',
      onchange: (e: Event) => {
        const ls = [...new Set((e.target as HTMLInputElement).value.split(/[,\s]+/).filter(Boolean))];
        if (ls.length) project.languages = ls;
        else delete project.languages;
        initLangSelect();
        void rebuild();
      },
    }), h('span', { class: 'hint' }, 'la 1re est la langue par défaut')),
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

  const langs = project.languages ?? [];
  const checks = langs.map((l) => ({ l, box: h('input', { type: 'checkbox', checked: true }) as HTMLInputElement }));

  const showForm = () =>
    body.replaceChildren(
      h('strong', {}, 'Exporter en MP4 (H.264 + AAC)'),
      h('div', { class: 'hint' }, `${project.project.resolution.join('×')} à ${project.project.fps} fps — ${fmtTime(compiled.total)} (${activeLang() ?? 'langue unique'}) — ${Math.round(compiled.total * project.project.fps)} images`),
      ...(langs.length
        ? [
            h('div', { class: 'hint' }, 'Une vidéo par langue cochée (durées propres à chaque langue) :'),
            ...checks.map(({ l, box }) => row(l, box, h('span', { class: 'hint' }, outputName(project.project.output_file, l)))),
          ]
        : []),
      row('Qualité CRF', crf, h('span', { class: 'hint' }, '18 = très bon, 23 = standard')),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: start }, 'Lancer l’export'),
        h('button', { onclick: () => (dlg.hidden = true) }, 'Fermer'),
      ),
    );

  /** Export des langues cochées, l'une après l'autre ; s'arrête à la première annulation ou erreur. */
  const start = async () => {
    const todo: (string | undefined)[] = langs.length ? checks.filter((c) => c.box.checked).map((c) => c.l) : [undefined];
    if (!todo.length) return;
    const done: string[] = [];
    for (const [i, lg] of todo.entries()) {
      if (!(await launch(lg))) return;
      const j = await watch(lg ? `${lg} (${i + 1}/${todo.length})` : '', done);
      if (j.status !== 'done') return;
      done.push(j.output);
    }
    finish(done);
  };

  const finish = (outputs: string[]) =>
    body.replaceChildren(
      h('strong', {}, outputs.length > 1 ? 'Exports terminés' : 'Export terminé'),
      ...outputs.map((o) => h('a', { href: `/exports/${encodeURIComponent(o)}`, download: o }, h('button', { class: 'primary' }, `Télécharger ${o}`))),
      h('div', { class: 'row' }, h('button', { onclick: () => (dlg.hidden = true) }, 'Fermer')),
    );

  /** Enregistre le projet puis lance l'export d'une langue. */
  const launch = async (lg?: string): Promise<boolean> => {
    const saved = await fetch('/api/project', { method: 'PUT', headers: writeHeaders({ 'Content-Type': 'application/json' }), body: serialize() });
    if (saved.status === 409) {
      body.replaceChildren(h('div', { class: 'errtext' }, (await saved.json()).error), h('button', { onclick: () => location.reload() }, 'Recharger la page'));
      return false;
    }
    const r = await fetch('/api/export', {
      method: 'POST',
      headers: writeHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ origin: location.origin, crf: Number(crf.value), lang: lg }),
    });
    if (!r.ok) {
      body.replaceChildren(h('div', { class: 'errtext' }, JSON.stringify(await r.json())), h('button', { onclick: showForm }, 'Retour'));
      return false;
    }
    return true;
  };

  /** Affiche la progression d'un export jusqu'à sa fin ; renvoie son état final. `label` : langue en cours. */
  const watch = async (label: string, finished: string[]): Promise<any> => {
    for (;;) {
      const j = await (await fetch('/api/export')).json();
      const running = j.status === 'running';
      const last = !running && j.status !== 'done'; // erreur ou annulation : la boucle des langues s'arrête
      const pct = j.total ? Math.round((j.frame / j.total) * 100) : 0;
      const warns = (j.warnings ?? []) as string[];
      const suffix = label ? ` — ${label}` : '';
      body.replaceChildren(...[
        h('strong', {}, j.status === 'error' ? 'Échec de l’export' : j.status === 'cancelled' ? 'Export annulé' : `Export en cours… ${pct}%${suffix}`),
        h('progress', { max: j.total || 1, value: j.frame ?? 0 }),
        finished.length ? h('div', { class: 'hint' }, `Terminé : ${finished.join(', ')}`) : null,
        j.error ? h('div', { class: 'errtext' }, j.error) : null,
        warns.length ? h('div', { class: 'warn' }, ...warns.map((w) => h('div', {}, '⚠ ' + w))) : null,
        h('div', { class: 'row' },
          running ? h('button', { class: 'danger', onclick: () => fetch('/api/export/cancel', { method: 'POST' }) }, 'Annuler')
            : last ? h('button', { onclick: () => (dlg.hidden = true) }, 'Fermer') : null,
        ),
      ].filter((x): x is HTMLElement => x != null));
      if (!running) return j;
      await new Promise((r) => setTimeout(r, 700));
    }
  };

  showForm();
};

// ---------- fichiers : import et glisser-déposer ----------

type Kind = 'image' | 'video' | 'audio' | 'font';
const kindOf = (name: string): Kind | null =>
  /\.(png|jpe?g|webp|gif)$/i.test(name) ? 'image'
  : /\.(webm|mp4|mov|m4v)$/i.test(name) ? 'video'
  : /\.(mp3|wav|ogg|m4a|flac)$/i.test(name) ? 'audio'
  : /\.(ttf|otf|woff2?)$/i.test(name) ? 'font'
  : null;
const defaultFolder = (k: Kind) => ({ image: 'illustrations', video: 'illustrations', audio: 'audio', font: 'fonts' })[k];

async function uploadFile(file: File, folder: string): Promise<string> {
  const path = `assets/${folder}/${file.name}`;
  const r = await fetch(`/api/upload?path=${encodeURIComponent(path)}`, { method: 'POST', headers: writeHeaders(), body: file });
  if (!r.ok) throw new Error((await r.json()).error);
  media.invalidate(path);
  audio.invalidate(path);
  return path;
}

/** Fichiers déposés (envoyés au serveur) ou asset glissé depuis la liste → chemins d'assets. */
async function resolveDrop(e: DragEvent, folderFor: (k: Kind) => string | undefined = () => undefined): Promise<string[]> {
  // à lire avant tout `await` : le DataTransfer est vidé après l'événement
  const asset = e.dataTransfer?.getData('text/asset');
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (asset) return [asset];
  const out: string[] = [];
  for (const f of files) {
    const k = kindOf(f.name);
    if (!k) continue;
    try {
      out.push(await uploadFile(f, folderFor(k) ?? defaultFolder(k)));
    } catch (err) {
      setStatus(`Envoi impossible : ${(err as Error).message}`, true);
    }
  }
  if (out.length) await refreshAssets();
  return out;
}

const viewport = $('viewport');
const dropOverlay = $('drop-overlay');
const isFileDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).some((x) => x === 'Files' || x === 'text/asset');
const hideDrop = () => ((dropOverlay.hidden = true), dropOverlay.querySelectorAll('.over').forEach((z) => z.classList.remove('over')));

window.addEventListener('dragenter', (e) => { if (isFileDrag(e)) dropOverlay.hidden = false; });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) hideDrop(); });
window.addEventListener('dragend', hideDrop);
// évite que le navigateur ouvre le fichier quand on rate la cible
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => (e.preventDefault(), hideDrop()));

dropOverlay.querySelectorAll<HTMLElement>('[data-zone]').forEach((zone) => {
  zone.addEventListener('dragover', (e) => (e.preventDefault(), zone.classList.add('over')));
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideDrop();
    void dropOnScene(e as DragEvent, zone.dataset.zone as 'bg' | 'el');
  });
});

async function dropOnScene(e: DragEvent, zone: 'bg' | 'el') {
  const [W, H] = project.project.resolution;
  const r = viewport.getBoundingClientRect();
  const px = ((e.clientX - r.left) / r.width) * W;
  const py = ((e.clientY - r.top) / r.height) * H;
  const s = project.timeline[selScene];
  const paths = await resolveDrop(e, (k) => (zone === 'bg' && k === 'image' ? 'backgrounds' : undefined));
  const added: any[] = [];
  for (const p of paths) {
    const k = kindOf(p);
    if (k === 'image' && zone === 'bg') s.background = p;
    else if (k === 'image' || k === 'video') {
      const el = { type: k, file: p, position: [Math.round(px), Math.round(py)] as [number, number], size: undefined as any };
      delete el.size;
      (s.elements ??= []).push(el as any);
      added.push(el);
    } else if (k === 'audio') (s.audio ??= []).push({ file: p, start: 0, volume: 1 });
  }
  compiled = compileNow();
  await media.preload(compiled);
  for (const el of added) {
    // taille initiale : tient à 60 % de l'écran, centré sur le point de dépôt
    const [nw, nh] = naturalOf(el.file, el.type);
    if (!nw) continue;
    const k = Math.min((W * 0.6) / nw, (H * 0.6) / nh);
    el.size = [Math.round(nw * k), Math.round(nh * k)];
    el.position = [Math.round(px - el.size[0] / 2), Math.round(py - el.size[1] / 2)];
  }
  if (added.length) selRef = added[added.length - 1];
  tab = 'scene';
  await rebuild();
}

// dépôt sur un champ « Fichier » / « Fond » / « Police » de l'inspecteur
const inspectorEl = $('inspector');
const fieldAt = (e: Event) => (e.target as HTMLElement).closest?.('input[list]') as HTMLInputElement | null;
inspectorEl.addEventListener('dragover', (e) => {
  const el = fieldAt(e);
  if (el) (e.preventDefault(), el.classList.add('dropping'));
});
inspectorEl.addEventListener('dragleave', (e) => fieldAt(e)?.classList.remove('dropping'));
inspectorEl.addEventListener('drop', async (e) => {
  const el = fieldAt(e);
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  hideDrop();
  el.classList.remove('dropping');
  const [path] = await resolveDrop(e as DragEvent, () => el.dataset.folder);
  if (!path) return;
  el.value = el.getAttribute('list') === 'dl-font' ? path.split('/').pop()!.replace(/\.[^.]+$/, '') : path;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await changed();
  renderInspector();
});

// ---------- sélection, déplacement et redimensionnement à la souris ----------

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
interface Box { x: number; y: number; w: number; h: number }

const overlay = $<HTMLCanvasElement>('overlay');
const octx = overlay.getContext('2d')!;
let selRef: any = null;
let guides: { x?: number; y?: number } = {};
let dragMoved = false; // un simple clic ne doit ni modifier ni enregistrer
let drag: null | { mode: 'move' | 'resize'; handle?: Handle; sx: number; sy: number; box: Box; pos: [number, number]; ref: any; kind: Layer['kind'] } = null;

function selectRef(ref: any, rerenderInspector: boolean) {
  selRef = ref;
  if (rerenderInspector) renderInspector();
  else {
    document.querySelectorAll('#inspector fieldset').forEach((f) => f.classList.toggle('selected', (f as any)._ref === ref));
  }
  drawOverlay();
}

function textAnchor(ref: any): 'left' | 'center' | 'right' {
  const st = project.styles[ref.style];
  return (st ? resolveStyle(st, ref).anchor : undefined) ?? 'center';
}

function selectedLayer(): Layer | undefined {
  return selRef ? sceneAt(compiled, t).layers.find((l) => l.ref === selRef) : undefined;
}

function layerBox(l: Layer): Box | null {
  const [W] = project.project.resolution;
  if (l.kind === 'text') {
    octx.save();
    const lay = layoutText(octx, project, l, W);
    octx.restore();
    if (!lay) return null;
    const x = lay.anchor === 'left' ? l.pos[0] : lay.anchor === 'right' ? l.pos[0] - lay.width : l.pos[0] - lay.width / 2;
    return { x, y: l.pos[1] - lay.height / 2, w: lay.width, h: lay.height };
  }
  const [nw, nh] = naturalOf(l.file, l.kind);
  const [w, h] = l.size ?? [nw || 400, nh || 300];
  return { x: l.pos[0], y: l.pos[1], w, h };
}

function handlePoints(b: Box, textOnly = false): [Handle, number, number][] {
  const { x, y, w, h } = b;
  // un texte ne se redimensionne qu'en largeur (la hauteur suit le retour à la ligne)
  if (textOnly) return [['e', x + w, y + h / 2], ['w', x, y + h / 2]];
  return [
    ['nw', x, y], ['n', x + w / 2, y], ['ne', x + w, y], ['e', x + w, y + h / 2],
    ['se', x + w, y + h], ['s', x + w / 2, y + h], ['sw', x, y + h], ['w', x, y + h / 2],
  ];
}

/** Rapport pixels-projet / pixels-écran de l'aperçu. */
const viewScale = () => project.project.resolution[0] / (overlay.clientWidth || project.project.resolution[0]);

function drawOverlay() {
  if (!project) return;
  const [W, H] = project.project.resolution;
  if (overlay.width !== W || overlay.height !== H) {
    overlay.width = W;
    overlay.height = H;
  }
  octx.clearRect(0, 0, W, H);
  if (playing) return;
  const k = viewScale();
  const l = selectedLayer();
  const b = l && layerBox(l);
  octx.save();
  if (l && b) {
    octx.lineWidth = 2 * k;
    octx.strokeStyle = '#f0a53c';
    octx.strokeRect(b.x, b.y, b.w, b.h);
    {
      const s = 10 * k;
      for (const [, px, py] of handlePoints(b, l.kind === 'text')) {
        octx.fillStyle = '#fff';
        octx.fillRect(px - s / 2, py - s / 2, s, s);
        octx.strokeRect(px - s / 2, py - s / 2, s, s);
      }
    }
  }
  octx.strokeStyle = '#00e0c0';
  octx.lineWidth = 1.5 * k;
  if (guides.x != null) (octx.beginPath(), octx.moveTo(guides.x, 0), octx.lineTo(guides.x, H), octx.stroke());
  if (guides.y != null) (octx.beginPath(), octx.moveTo(0, guides.y), octx.lineTo(W, guides.y), octx.stroke());
  octx.restore();
}

function fitViewport() {
  if (!project) return;
  const stage = document.querySelector<HTMLElement>('.stage')!;
  const [W, H] = project.project.resolution;
  const k = Math.min(stage.clientWidth / W, stage.clientHeight / H);
  viewport.style.width = `${Math.floor(W * k)}px`;
  viewport.style.height = `${Math.floor(H * k)}px`;
  drawOverlay();
}
new ResizeObserver(fitViewport).observe(document.querySelector('.stage')!);
window.addEventListener('resize', fitViewport);

const toProject = (e: PointerEvent): [number, number] => {
  const r = overlay.getBoundingClientRect();
  const [W, H] = project.project.resolution;
  return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
};

function handleAt(b: Box, x: number, y: number, textOnly = false): Handle | null {
  const r = 9 * viewScale();
  for (const [name, px, py] of handlePoints(b, textOnly)) if (Math.abs(x - px) <= r && Math.abs(y - py) <= r) return name;
  return null;
}

const inBox = (b: Box, x: number, y: number) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

function pick(x: number, y: number): Layer | null {
  const s = sceneAt(compiled, t);
  const lt = t - s.start;
  for (const l of [...s.layers].reverse()) {
    if (lt < l.t0 || lt >= l.t1) continue;
    const b = layerBox(l);
    if (b && inBox(b, x, y)) return l;
  }
  return null;
}

const CURSORS: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

/** Aimante les bords et le centre du cadre sur ceux de l'écran (désactivable avec Alt). */
function snap(v: number, size: number, max: number, thr: number): { v: number; guide?: number } {
  let best: { d: number; shift: number; guide: number } | null = null;
  for (const off of [0, size / 2, size]) {
    for (const target of [0, max / 2, max]) {
      const d = Math.abs(v + off - target);
      if (d <= thr && (!best || d < best.d)) best = { d, shift: target - (v + off), guide: target };
    }
  }
  return best ? { v: v + best.shift, guide: best.guide } : { v };
}

overlay.addEventListener('pointerdown', (e) => {
  if (playing) return;
  const [x, y] = toProject(e);
  const cur = selectedLayer();
  const curBox = cur && layerBox(cur);
  let l: Layer | null = null;
  let handle: Handle | null = null;
  if (cur && curBox) {
    handle = handleAt(curBox, x, y, cur.kind === 'text');
    if (handle || inBox(curBox, x, y)) l = cur;
  }
  l ??= pick(x, y);
  if (!l) {
    selectRef(null, false);
    return;
  }
  if (l.ref !== selRef) {
    tab = 'scene';
    selRef = l.ref;
    collapsed.delete(l.ref); // la section de l'élément cliqué est dépliée
    renderInspector();
    document.querySelector('#inspector fieldset.selected')?.scrollIntoView({ block: 'nearest' });
  }
  const box = layerBox(l)!;
  if (handle && l.kind !== 'text' && !l.ref.size) l.ref.size = [Math.round(box.w), Math.round(box.h)];
  drag = { mode: handle ? 'resize' : 'move', handle: handle ?? undefined, sx: x, sy: y, box, pos: [...l.pos] as [number, number], ref: l.ref, kind: l.kind };
  dragMoved = false;
  overlay.setPointerCapture(e.pointerId);
  drawOverlay();
});

overlay.addEventListener('pointermove', (e) => {
  const [x, y] = toProject(e);
  if (!drag) {
    const l = selectedLayer();
    const b = l && layerBox(l);
    const hd = l && b ? handleAt(b, x, y, l.kind === 'text') : null;
    overlay.style.cursor = hd ? CURSORS[hd] : b && inBox(b, x, y) ? 'move' : pick(x, y) ? 'pointer' : 'default';
    return;
  }
  const [W, H] = project.project.resolution;
  const thr = e.altKey ? 0 : 8 * viewScale();
  const { box, ref } = drag;
  if (!dragMoved && Math.hypot(x - drag.sx, y - drag.sy) < 3 * viewScale()) return;
  dragMoved = true;
  guides = {};

  if (drag.mode === 'move') {
    const sx = snap(box.x + (x - drag.sx), box.w, W, thr);
    const sy = snap(box.y + (y - drag.sy), box.h, H, thr);
    guides = { x: sx.guide, y: sy.guide };
    const dx = sx.v - box.x;
    const dy = sy.v - box.y;
    // texte : `position` = point d'ancrage ; image / vidéo : coin supérieur gauche
    ref.position = [Math.round(drag.pos[0] + dx), Math.round(drag.pos[1] + dy)];
  } else {
    const hd = drag.handle!;
    if (drag.kind === 'text') {
      // largeur de la zone ; `position` reste le point d'ancrage (bord gauche, centre ou bord droit)
      let x1 = box.x, x2 = box.x + box.w;
      if (hd === 'e') x2 = Math.max(x, x1 + 40);
      else x1 = Math.min(x, x2 - 40);
      ref.width = Math.round(x2 - x1);
      const anchor = textAnchor(ref);
      ref.position = [Math.round(anchor === 'left' ? x1 : anchor === 'right' ? x2 : (x1 + x2) / 2), ref.position[1]];
      compiled = compileNow();
      void draw(false);
      return;
    }
    let x1 = box.x, x2 = box.x + box.w, y1 = box.y, y2 = box.y + box.h;
    if (hd.includes('e')) x2 = Math.max(x, x1 + 10);
    if (hd.includes('w')) x1 = Math.min(x, x2 - 10);
    if (hd.includes('s')) y2 = Math.max(y, y1 + 10);
    if (hd.includes('n')) y1 = Math.min(y, y2 - 10);
    if (hd.length === 2 && !e.shiftKey) {
      // coin : proportions conservées (Maj = déformer librement)
      const s = Math.max((x2 - x1) / box.w, (y2 - y1) / box.h);
      const w = box.w * s;
      const h = box.h * s;
      if (hd.includes('e')) x2 = x1 + w; else x1 = x2 - w;
      if (hd.includes('s')) y2 = y1 + h; else y1 = y2 - h;
    }
    ref.position = [Math.round(x1), Math.round(y1)];
    ref.size = [Math.round(x2 - x1), Math.round(y2 - y1)];
  }
  compiled = compileNow();
  void draw(false);
});

const endDrag = () => {
  if (!drag) return;
  drag = null;
  guides = {};
  if (!dragMoved) return drawOverlay();
  void changed().then(() => {
    if (tab === 'scene') renderInspector();
  });
};
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);

// ---------- projets ----------

async function switchProject(url: string, body: object) {
  // sauvegarde immédiate des modifications en attente avant de changer de projet
  if (saveTimer) {
    clearTimeout(saveTimer);
    await fetch('/api/project', { method: 'PUT', headers: writeHeaders({ 'Content-Type': 'application/json' }), body: serialize() });
  }
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.ok) location.reload();
  else alert((await r.json()).error);
}

async function initProjects() {
  const { current, projects } = await (await fetch('/api/projects')).json();
  const sel = $<HTMLSelectElement>('project-select');
  sel.replaceChildren(...projects.map((p: string) => h('option', { value: p }, p)));
  sel.value = current;
  sel.onchange = () => switchProject('/api/projects/open', { name: sel.value });
  $('new-project').onclick = () => {
    const name = prompt('Nom du nouveau projet (ex. ep2)')?.trim();
    if (name) void switchProject('/api/projects/create', { name });
  };
}

// ---------- démarrage ----------

(async () => {
  await initProjects();
  const res = await fetch('/api/project');
  currentProject = res.headers.get('X-Project') ?? ''; // le nom arrive avec les données : même instant, même projet
  project = await res.json();
  // ancien format : `illustration` devient le premier élément (le plus au fond), pour pouvoir le réordonner
  for (const sc of project.timeline) {
    if (!sc.illustration) continue;
    (sc.elements ??= []).unshift({ type: 'image', ...sc.illustration });
    delete sc.illustration;
  }
  initLangSelect();
  compiled = compileNow();
  await refreshAssets();
  await changed();
  renderInspector();
  fitViewport();
  setStatus('Chargé');
})();
