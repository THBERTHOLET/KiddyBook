// Petits constructeurs de formulaires. Chaque champ écrit directement dans l'objet édité.

export type Props = Record<string, any>;

export function h(tag: string, props: Props = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

type Obj = Record<string, any>;
type Notify = () => void;

export function row(label: string, ...ctl: HTMLElement[]) {
  return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctl' }, ...ctl));
}

/** `folder` : dossier d'assets où atterrissent les fichiers déposés sur ce champ. */
export function textField(o: Obj, k: string, notify: Notify, opt: { list?: string; optional?: boolean; folder?: string } = {}) {
  return h('input', {
    type: 'text',
    value: o[k] ?? '',
    list: opt.list,
    'data-folder': opt.folder,
    oninput: (e: Event) => {
      const v = (e.target as HTMLInputElement).value;
      if (opt.optional && v === '') delete o[k];
      else o[k] = v;
      notify();
    },
  });
}

export function areaField(o: Obj, k: string, notify: Notify) {
  const a = h('textarea', {
    oninput: (e: Event) => {
      o[k] = (e.target as HTMLTextAreaElement).value;
      notify();
    },
  }) as HTMLTextAreaElement;
  a.value = o[k] ?? '';
  return a;
}

export function numField(o: Obj, k: string, notify: Notify, opt: { step?: number; min?: number; max?: number; optional?: boolean } = {}) {
  return h('input', {
    type: 'number',
    value: o[k] ?? '',
    step: opt.step ?? 0.1,
    min: opt.min,
    max: opt.max,
    oninput: (e: Event) => {
      const raw = (e.target as HTMLInputElement).value;
      if (raw === '') {
        if (opt.optional) delete o[k];
        else return;
      } else o[k] = Number(raw);
      notify();
    },
  });
}

/** Champ [a, b] (position, taille, résolution). */
export function vecField(o: Obj, k: string, notify: Notify, opt: { optional?: boolean; step?: number } = {}) {
  const cur = () => (o[k] as [number, number] | undefined);
  const mk = (i: 0 | 1) =>
    h('input', {
      type: 'number',
      value: cur()?.[i] ?? '',
      step: opt.step ?? 1,
      oninput: (e: Event) => {
        const raw = (e.target as HTMLInputElement).value;
        const v = cur() ?? [0, 0];
        if (raw === '' && opt.optional) {
          delete o[k];
        } else {
          v[i] = Number(raw || 0);
          o[k] = v;
        }
        notify();
      },
    });
  return [mk(0), mk(1)];
}

export function selectField(o: Obj, k: string, options: string[], notify: Notify, opt: { optional?: boolean } = {}) {
  const sel = h(
    'select',
    {
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        if (opt.optional && v === '') delete o[k];
        else o[k] = v;
        notify();
      },
    },
    ...(opt.optional ? [h('option', { value: '' }, '—')] : []),
    ...options.map((x) => h('option', { value: x }, x)),
  ) as HTMLSelectElement;
  sel.value = o[k] ?? '';
  return sel;
}

export function checkField(o: Obj, k: string, notify: Notify) {
  const c = h('input', {
    type: 'checkbox',
    onchange: (e: Event) => {
      o[k] = (e.target as HTMLInputElement).checked;
      notify();
    },
  }) as HTMLInputElement;
  c.checked = !!o[k];
  return c;
}

export function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
}
