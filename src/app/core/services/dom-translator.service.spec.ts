import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomTranslatorService, englishOrdinal } from './dom-translator.service';

const DICT = {
  'রিফ্রেশ': 'Refresh',
  'জন মাঠকর্মী': 'field officers',
  'সঞ্চয় জমা': 'Savings Deposit',
  'সঞ্চয়': 'Savings',
  'অনুসন্ধান করুন': 'Search',
  'ম ঋণ চক্র': 'th loan cycle'
};

const flush = () => new Promise(r => setTimeout(r, 0));

describe('DomTranslatorService', () => {
  let service: DomTranslatorService;
  let host: HTMLElement;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => DICT })));
    TestBed.configureTestingModule({});
    service = TestBed.inject(DomTranslatorService);
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(async () => {
    await service.apply('bn');
    host.remove();
    vi.unstubAllGlobals();
  });

  it('translates exact strings, fragments around values and Bengali digits', async () => {
    await service.apply('en');
    expect(service.translate(' রিফ্রেশ ')).toBe(' Refresh ');
    expect(service.translate('৩ জন মাঠকর্মী')).toBe('3 field officers');
    // longest phrase wins; no match inside another Bengali word
    expect(service.translate('সঞ্চয় জমা ৳৫০')).toBe('Savings Deposit ৳50');
    expect(service.translate('রহিমা বেগম')).toBe('রহিমা বেগম');
    expect(service.translate('English stays')).toBe('English stays');
    expect(service.translate('রিফ্রেশ (Refresh)')).toBe('Refresh');
  });

  it('uses the correct English ordinal suffix', async () => {
    await service.apply('en');
    // Angular "{{ loanCycle }}ম ঋণ চক্র" — সংখ্যা ASCII অঙ্কে আসে
    expect(service.translate('2ম ঋণ চক্র')).toBe('2nd loan cycle');
    expect(service.translate('1ম ঋণ চক্র')).toBe('1st loan cycle');
    expect(service.translate('3ম ঋণ চক্র')).toBe('3rd loan cycle');
    expect(service.translate('11ম ঋণ চক্র')).toBe('11th loan cycle');
    expect(service.translate('রিফ্রেশ 2024')).toBe('Refresh 2024');
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(englishOrdinal))
      .toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th', '112th']);
  });

  it('switches the screen to English, follows later updates and restores Bangla', async () => {
    host.innerHTML = '<button title="রিফ্রেশ">রিফ্রেশ</button><input placeholder="অনুসন্ধান করুন"><span translate="no">সঞ্চয়</span>';
    const button = host.querySelector('button')!;
    const input = host.querySelector('input')!;

    await service.apply('en');
    expect(button.textContent).toBe('Refresh');
    expect(button.title).toBe('Refresh');
    expect(input.placeholder).toBe('Search');
    expect(host.querySelector('span')!.textContent).toBe('সঞ্চয়');

    // Angular-like update: new node and changed text are translated too
    const p = document.createElement('p');
    p.textContent = '২ জন মাঠকর্মী';
    host.appendChild(p);
    (button.firstChild as Text).data = 'সঞ্চয়';
    await flush();
    expect(p.textContent).toBe('2 field officers');
    expect(button.textContent).toBe('Savings');

    await service.apply('bn');
    expect(button.textContent).toBe('সঞ্চয়');
    expect(button.title).toBe('রিফ্রেশ');
    expect(input.placeholder).toBe('অনুসন্ধান করুন');
    expect(p.textContent).toBe('২ জন মাঠকর্মী');
  });

  it('keeps the same size: shrinks the font when English is wider, restores it for Bangla', async () => {
    // ভুয়া মাপ: প্রতিটি অক্ষর 10px চওড়া
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '', measureText: (t: string) => ({ width: t.length * 10 })
    } as unknown as CanvasRenderingContext2D);
    host.innerHTML = '<button style="font-size: 20px">সঞ্চয় জমা</button><b style="font-size: 20px">রিফ্রেশ</b>';
    const longer = host.querySelector('button')!;   // 9 → 15 chars: 60% → floor 72%
    const shorter = host.querySelector('b')!;       // 7 → 7 chars: unchanged

    await service.apply('en');
    await new Promise(r => setTimeout(r, 50));
    expect(longer.textContent).toBe('Savings Deposit');
    expect(parseFloat(longer.style.fontSize)).toBeCloseTo(14.4);
    expect(shorter.style.fontSize).toBe('20px');

    await service.apply('bn');
    expect(longer.style.fontSize).toBe('20px');
    expect(longer.textContent).toBe('সঞ্চয় জমা');
  });

  it('shrinks all headings of a table header row by the same amount', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '', measureText: (t: string) => ({ width: t.length * 10 })
    } as unknown as CanvasRenderingContext2D);
    host.innerHTML = '<table><thead><tr><th style="font-size: 20px">সঞ্চয় জমা</th><th style="font-size: 20px">রিফ্রেশ</th></tr></thead></table>';
    const [wide, same] = Array.from(host.querySelectorAll('th'));

    await service.apply('en');
    await new Promise(r => setTimeout(r, 50));
    expect(parseFloat(wide.style.fontSize)).toBeCloseTo(14.4);
    expect(parseFloat(same.style.fontSize)).toBeCloseTo(14.4);
  });

  it('translates Bengali month and weekday names inside formatted dates', async () => {
    await service.apply('en');
    const bnShort = new Intl.DateTimeFormat('bn-BD', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const out = service.translate(bnShort.format(new Date(Date.UTC(2026, 10, 5))));
    expect(out).not.toMatch(/[ঀ-৿]/);
    expect(out).toContain('5');
  });
});
