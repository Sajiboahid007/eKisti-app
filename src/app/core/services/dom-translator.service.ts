import { Injectable } from '@angular/core';
import { LanguageCode } from './language.service';

/** অনুবাদযোগ্য অ্যাট্রিবিউট */
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
const BN_CHAR = /[ঀ-৿]/;
const BN_DIGITS = /[০-৯]/g;
/** বাংলা "২ম / ২য়" অনুবাদে সব সংখ্যার পরে "th" আসে — ইংরেজি ক্রমবাচক প্রত্যয় ঠিক করা হয় */
const ORDINAL = /\b(\d+)(?:st|nd|rd|th)\b/g;

/** 1 → "1st", 2 → "2nd", 3 → "3rd", 11–13 → "th", 21 → "21st" */
export function englishOrdinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] || 'th'}`;
}
/** যেখানে অনুবাদ চলবে না */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE']);
/** ইংরেজি লম্বা হলে ফন্ট এর চেয়ে ছোট করা হবে না (পড়ার সুবিধা) */
const MIN_FONT_SCALE = 0.72;
/** একই সারির লেখা একই হারে ছোট হবে (নইলে কলাম শিরোনাম বিভিন্ন মাপের দেখায়) */
const FIT_GROUP = 'thead tr, .tab-bar';
/** এসব এলিমেন্টের ফন্ট আলাদা করে বদলানো যায় না / উচিত নয় */
const NO_FIT_TAGS = new Set(['OPTION', 'OPTGROUP', 'SELECT', 'TITLE', 'BODY', 'HTML']);

/**
 * ইংরেজি মোড: পুরো স্ক্রিনের বাংলা লেখা রানটাইমে ইংরেজিতে বদলায় (public/i18n/en.json অভিধান)।
 *
 * টেমপ্লেট ও সার্ভিসের বাংলা লেখা আলাদা করে key বানানোর বদলে DOM-এর টেক্সট নোড ও অ্যাট্রিবিউট
 * (placeholder, title…) অনুবাদ হয়। মূল বাংলা লেখা সংরক্ষিত থাকে, তাই বাংলায় ফিরলে হুবহু ফেরত আসে।
 * Angular পরে লেখা বদলালে MutationObserver নতুন লেখাটিও অনুবাদ করে।
 * অভিধান তৈরি: `npm run i18n:extract` (নতুন বাংলা লেখা যোগ হলে)।
 *
 * ভাষা বদলালে লেআউট একই থাকে: ইংরেজি লেখা বাংলার চেয়ে চওড়া হলে সেই এলিমেন্টের ফন্ট
 * সমানুপাতিকভাবে ছোট হয় (সর্বনিম্ন MIN_FONT_SCALE), যাতে বাটন, কার্ড, টেবিল একই মাপে থাকে।
 * বাংলায় ফিরলে মূল ফন্ট সাইজ ফেরত আসে।
 *
 * ব্যবহারকারীর এন্ট্রি করা তথ্য (নাম, ঠিকানা) অভিধানে না থাকলে যেমন আছে তেমনই দেখায়।
 * `translate="no"` বা `.notranslate` দেওয়া অংশ বাদ যায়।
 */
@Injectable({ providedIn: 'root' })
export class DomTranslatorService {
  private dict: Map<string, string> | null = null;
  private phraseRe: RegExp | null = null;
  private loading: Promise<void> | null = null;
  private observer: MutationObserver | null = null;
  private active = false;

  /** টেক্সট নোডের মূল বাংলা ও আমাদের লেখা ইংরেজি */
  private textOriginal = new WeakMap<Text, string>();
  private textWritten = new WeakMap<Text, string>();
  private attrOriginal = new WeakMap<Element, Map<string, string>>();
  private attrWritten = new WeakMap<Element, Map<string, string>>();
  /** ফন্ট ছোট করা এলিমেন্টের আগের inline font-size ও মূল (বাংলা) সাইজ */
  private fitOriginal = new WeakMap<HTMLElement, { inline: string; basePx: number }>();
  private fitQueue = new Set<HTMLElement>();
  private fitScheduled = false;
  private measureCtx: CanvasRenderingContext2D | null | undefined;

  private nativeAlert = typeof window !== 'undefined' ? window.alert.bind(window) : null;
  private nativeConfirm = typeof window !== 'undefined' ? window.confirm.bind(window) : null;
  private nativePrompt = typeof window !== 'undefined' ? window.prompt.bind(window) : null;

  async apply(lang: LanguageCode): Promise<void> {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = lang;
    if (lang === 'en') {
      await this.ensureDictionary();
      if (!this.dict) return;
      this.active = true;
      this.translateTree(document.body);
      this.observe();
      this.patchDialogs(true);
    } else {
      this.active = false;
      this.fitQueue.clear();
      this.observer?.disconnect();
      this.observer = null;
      this.restoreTree(document.body);
      this.patchDialogs(false);
    }
  }

  /** একটি বাংলা লেখার ইংরেজি (অভিধানে না থাকলে শব্দগুচ্ছ ধরে, বাকিটা যেমন আছে) */
  translate(text: string): string {
    if (!this.dict || !BN_CHAR.test(text)) return text;
    const lead = text.match(/^\s*/)![0];
    const trail = text.slice(lead.length).match(/\s*$/)![0];
    const core = text.slice(lead.length, text.length - trail.length).replace(/\s+/g, ' ');
    let out = this.dict.get(core);
    if (out === undefined) {
      out = this.phraseRe ? core.replace(this.phraseRe, m => this.dict!.get(m) ?? m) : core;
    }
    out = out
      .replace(BN_DIGITS, d => String(d.charCodeAt(0) - 0x09E6))
      .replace(ORDINAL, (_, n: string) => englishOrdinal(Number(n)))
      // "মিরপুর শাখা (Mirpur Branch)" → "Mirpur Branch", দুবার নয়
      .replace(/(?<![\w&'.-])([A-Za-z][\w&'. -]*?) \(\1\)/g, '$1');
    return lead + out + trail;
  }

  private async ensureDictionary(): Promise<void> {
    if (this.dict) return;
    this.loading ??= (async () => {
      try {
        const res = await fetch('/i18n/en.json', { cache: 'no-cache' });
        const json = (await res.json()) as Record<string, string>;
        const map = new Map(Object.entries(json));
        this.addDateNames(map);
        // লম্বা বাক্যাংশ আগে, যাতে ছোট শব্দ বড় বাক্যাংশকে না ভাঙে; বাংলা শব্দের ভেতরে মিল নয়
        const keys = [...map.keys()].filter(k => BN_CHAR.test(k)).sort((a, b) => b.length - a.length);
        const escaped = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        this.phraseRe = keys.length ? new RegExp(`(?<![\\u0980-\\u09FF])(?:${escaped.join('|')})(?![\\u0980-\\u09FF])`, 'g') : null;
        this.dict = map;
      } catch (err) {
        console.error('English dictionary could not be loaded:', err);
        this.loading = null;
      }
    })();
    await this.loading;
  }

  /**
   * Intl bn-BD তারিখের মাস ও বারের নাম। পুরো তারিখের ভেতরের রূপ (যেমন "বৃহঃ, ৫ নভে"-এর "নভে")
   * আলাদা নামের রূপ থেকে ভিন্ন হতে পারে, তাই formatToParts দিয়ে আসল ফরম্যাট থেকেই নেওয়া হয়।
   */
  private addDateNames(map: Map<string, string>) {
    const opts: Intl.DateTimeFormatOptions[] = [
      { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
      { weekday: 'short', day: 'numeric', month: 'short' },
      { month: 'long' }, { month: 'short' }, { weekday: 'long' }, { weekday: 'short' }
    ];
    for (const o of opts) {
      const bn = new Intl.DateTimeFormat('bn-BD', { ...o, timeZone: 'UTC' });
      const en = new Intl.DateTimeFormat('en-GB', { ...o, timeZone: 'UTC' });
      for (let i = 0; i < 12; i++) {
        const d = new Date(Date.UTC(2024, i, 1 + i));
        const bnParts = bn.formatToParts(d), enParts = en.formatToParts(d);
        for (const type of ['month', 'weekday'] as const) {
          const k = bnParts.find(p => p.type === type)?.value;
          const v = enParts.find(p => p.type === type)?.value;
          if (k && v && !map.has(k)) map.set(k, v);
        }
      }
    }
  }

  private skip(el: Element | null): boolean {
    for (let e = el; e; e = e.parentElement) {
      if (SKIP_TAGS.has(e.tagName) || e.getAttribute('translate') === 'no' && e !== document.documentElement || e.classList.contains('notranslate')) return true;
    }
    return false;
  }

  private translateTree(root: Node) {
    if (root.nodeType === Node.TEXT_NODE) { this.translateText(root as Text); return; }
    if (!(root instanceof Element) || this.skip(root)) return;
    this.translateAttrs(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: n => n instanceof Element && (SKIP_TAGS.has(n.tagName) || n.getAttribute('translate') === 'no' || n.classList.contains('notranslate'))
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) this.translateText(n as Text);
      else this.translateAttrs(n as Element);
    }
  }

  private translateText(node: Text) {
    const current = node.data;
    if (this.textWritten.get(node) === current) return;
    if (!BN_CHAR.test(current)) return;
    const english = this.translate(current);
    this.textOriginal.set(node, current);
    this.textWritten.set(node, english);
    if (english !== current) node.data = english;
    if (node.parentElement instanceof HTMLElement) this.queueFit(node.parentElement);
  }

  // ---------------- একই মাপ রাখা (font fit) ----------------

  private queueFit(el: HTMLElement) {
    if (NO_FIT_TAGS.has(el.tagName)) return;
    const group = el.closest(FIT_GROUP);
    this.fitQueue.add(group instanceof HTMLElement ? group : el);
    if (this.fitScheduled) return;
    this.fitScheduled = true;
    const run = () => {
      this.fitScheduled = false;
      const batch = [...this.fitQueue];
      this.fitQueue.clear();
      if (this.active) batch.forEach(e => e.matches(FIT_GROUP) ? this.fitGroup(e) : this.fit(e));
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else setTimeout(run, 0);
  }

  /** এলিমেন্টের সরাসরি লেখার বাংলা ও ইংরেজি চওড়া মেপে ফন্ট ছোট করে */
  private fit(el: HTMLElement) {
    const m = this.measure(el);
    if (m) this.applyScale(el, m.basePx, m.scale);
  }

  /** দলের (টেবিল শিরোনাম সারি, ট্যাব) সব লেখায় সবচেয়ে ছোট হারটাই প্রয়োগ */
  private fitGroup(group: HTMLElement) {
    if (!group.isConnected) return;
    const items: { el: HTMLElement; basePx: number }[] = [];
    let scale = 1;
    group.querySelectorAll<HTMLElement>('*').forEach(el => {
      if (NO_FIT_TAGS.has(el.tagName) || this.skip(el)) return;
      const m = this.measure(el);
      if (!m) return;
      items.push({ el, basePx: m.basePx });
      scale = Math.min(scale, m.scale);
    });
    items.forEach(i => this.applyScale(i.el, i.basePx, scale));
  }

  /** বাংলা বনাম ইংরেজি চওড়া → ছোট করার হার (লেখা না থাকলে null) */
  private measure(el: HTMLElement): { basePx: number; scale: number } | null {
    if (!el.isConnected) return null;
    let bn = '', en = '';
    el.childNodes.forEach(n => {
      if (n.nodeType !== Node.TEXT_NODE) return;
      const t = n as Text;
      const orig = this.textOriginal.get(t);
      bn += orig !== undefined && this.textWritten.get(t) === t.data ? orig : t.data;
      en += t.data;
    });
    bn = bn.replace(/\s+/g, ' ').trim();
    en = en.replace(/\s+/g, ' ').trim();
    if (!bn || !en) return null;

    const style = getComputedStyle(el);
    const basePx = this.fitOriginal.get(el)?.basePx ?? parseFloat(style.fontSize) * this.ancestorShrink(el);
    if (!(basePx > 0)) return null;
    const ctx = this.ctx();
    if (!ctx) return null;
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${basePx}px ${style.fontFamily}`;
    const bnW = ctx.measureText(bn).width;
    const enW = ctx.measureText(en).width;
    if (!(bnW > 0) || !(enW > 0)) return null;
    return { basePx, scale: Math.max(MIN_FONT_SCALE, Math.min(1, bnW / enW)) };
  }

  private applyScale(el: HTMLElement, basePx: number, scale: number) {
    let saved = this.fitOriginal.get(el);
    if (scale >= 0.98) {
      // ইংরেজি সমান বা ছোট — আগে ছোট করা থাকলে ফেরত
      if (saved) { el.style.fontSize = saved.inline; this.fitOriginal.delete(el); }
      return;
    }
    if (!saved) {
      saved = { inline: el.style.fontSize, basePx };
      this.fitOriginal.set(el, saved);
    }
    el.style.fontSize = `${(basePx * scale).toFixed(2)}px`;
  }

  /** উপরের কোনো এলিমেন্ট আগেই ছোট করা হলে উত্তরাধিকার সূত্রে পাওয়া ফন্টও ছোট — মূল মাপে ফেরাতে গুণক (দুবার ছোট নয়) */
  private ancestorShrink(el: HTMLElement): number {
    for (let a = el.parentElement; a; a = a.parentElement) {
      const saved = this.fitOriginal.get(a);
      if (saved) {
        const current = parseFloat(a.style.fontSize);
        return current > 0 ? saved.basePx / current : 1;
      }
    }
    return 1;
  }

  private ctx(): CanvasRenderingContext2D | null {
    if (this.measureCtx === undefined) {
      try { this.measureCtx = document.createElement('canvas').getContext('2d'); } catch { this.measureCtx = null; }
    }
    return this.measureCtx ?? null;
  }

  private translateAttrs(el: Element) {
    for (const name of ATTRS) {
      const current = el.getAttribute(name);
      if (!current || this.attrWritten.get(el)?.get(name) === current || !BN_CHAR.test(current)) continue;
      const english = this.translate(current);
      if (!this.attrOriginal.has(el)) { this.attrOriginal.set(el, new Map()); this.attrWritten.set(el, new Map()); }
      this.attrOriginal.get(el)!.set(name, current);
      this.attrWritten.get(el)!.set(name, english);
      if (english !== current) el.setAttribute(name, english);
    }
  }

  private restoreTree(root: Node) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n: Node | null = root; n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) {
        const t = n as Text;
        const orig = this.textOriginal.get(t);
        if (orig !== undefined && this.textWritten.get(t) === t.data) t.data = orig;
        this.textOriginal.delete(t);
        this.textWritten.delete(t);
      } else if (n instanceof Element) {
        const fitted = n instanceof HTMLElement ? this.fitOriginal.get(n) : undefined;
        if (fitted) { (n as HTMLElement).style.fontSize = fitted.inline; this.fitOriginal.delete(n as HTMLElement); }
        const origs = this.attrOriginal.get(n);
        if (origs) {
          const written = this.attrWritten.get(n)!;
          origs.forEach((orig, name) => { if (n.getAttribute(name) === written.get(name)) n.setAttribute(name, orig); });
          this.attrOriginal.delete(n);
          this.attrWritten.delete(n);
        }
      }
    }
  }

  private observe() {
    if (this.observer) return;
    this.observer = new MutationObserver(records => {
      if (!this.active) return;
      for (const r of records) {
        if (r.type === 'characterData') {
          const t = r.target as Text;
          if (!this.skip(t.parentElement)) this.translateText(t);
        } else if (r.type === 'attributes') {
          const el = r.target as Element;
          if (!this.skip(el)) this.translateAttrs(el);
        } else {
          r.addedNodes.forEach(n => {
            if (n.nodeType === Node.TEXT_NODE ? !this.skip(n.parentElement) : true) this.translateTree(n);
          });
        }
      }
    });
    this.observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  /** alert / confirm / prompt-এর বাংলা বার্তাও ইংরেজিতে */
  private patchDialogs(on: boolean) {
    if (!this.nativeAlert || !this.nativeConfirm || !this.nativePrompt) return;
    if (on) {
      window.alert = (msg?: any) => this.nativeAlert!(typeof msg === 'string' ? this.translate(msg) : msg);
      window.confirm = (msg?: string) => this.nativeConfirm!(msg ? this.translate(msg) : msg);
      window.prompt = (msg?: string, def?: string) => this.nativePrompt!(msg ? this.translate(msg) : msg, def);
    } else {
      window.alert = this.nativeAlert;
      window.confirm = this.nativeConfirm;
      window.prompt = this.nativePrompt;
    }
  }
}
