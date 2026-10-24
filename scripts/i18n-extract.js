/**
 * ইংরেজি অভিধান রক্ষণাবেক্ষণ (DomTranslatorService)।
 *
 * src/app-এর সব বাংলা লেখা (টেমপ্লেট ও TypeScript) খুঁজে public/i18n/en.json-এর সাথে মেলায়।
 * অভিধানে নেই এমন লেখা public/i18n/missing.json-এ লেখে — সেগুলোর ইংরেজি en.json-এ যোগ করুন।
 *
 *   npm run i18n:extract
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'app');
const DICT = path.join(ROOT, 'public', 'i18n', 'en.json');
const MISSING = path.join(ROOT, 'public', 'i18n', 'missing.json');

function collectFiles(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) collectFiles(p, out);
    else if (/\.(html|ts)$/.test(f) && !/\.spec\.ts$/.test(f) && !/(language|dom-translator)\.service\.ts$/.test(f)) out.push(p);
  }
  return out;
}

/** একটানা বাংলা লেখার অংশ (ট্যাগ, ইন্টারপোলেশন, উদ্ধৃতিচিহ্নে থামে) */
const BN = '\\u0980-\\u09FF';
const SEGMENT = new RegExp('[' + BN + '](?:[^<>{}"\'`\\n@|;]*[' + BN + '\\)\\]।%?!])?', 'gu');

function extract() {
  const set = new Set();
  for (const f of collectFiles(SRC)) {
    let src = fs.readFileSync(f, 'utf8');
    src = f.endsWith('.ts')
      ? src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      : src.replace(/<!--[\s\S]*?-->/g, '');
    for (const m of src.match(SEGMENT) || []) {
      let s = m.replace(/\s+/g, ' ').trim();
      const open = (s.match(/\(/g) || []).length;
      const close = (s.match(/\)/g) || []).length;
      if (close > open && s.endsWith(')')) s = s.slice(0, -1).trim();
      if (s) set.add(s);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

const strings = extract();
const dict = fs.existsSync(DICT) ? JSON.parse(fs.readFileSync(DICT, 'utf8')) : {};
const missing = strings.filter(s => !(s in dict));

fs.mkdirSync(path.dirname(MISSING), { recursive: true });
if (missing.length) {
  fs.writeFileSync(MISSING, JSON.stringify(Object.fromEntries(missing.map(s => [s, ''])), null, 1));
  console.log(`${strings.length} Bengali strings, ${missing.length} missing an English translation → public/i18n/missing.json`);
} else {
  if (fs.existsSync(MISSING)) fs.unlinkSync(MISSING);
  console.log(`${strings.length} Bengali strings — all translated.`);
}
