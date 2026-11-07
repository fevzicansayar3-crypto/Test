#!/usr/bin/env node
// index.html'e shim'i ekler, davet BASE adresini düzeltir, "Claude hesabı" ifadelerini raporlar.
// Kullanım: node scripts/patch-index.js public/index.html
'use strict';
const fs = require('fs');
const file = process.argv[2] || 'public/index.html';
let html = fs.readFileSync(file, 'utf8');
const TAG = '<script src="/shim.js"></script>';
let changed = false;

if (!html.includes(TAG)) {
  const m = html.match(/<head[^>]*>/i);
  if (!m) { console.error('HATA: <head> bulunamadı'); process.exit(1); }
  html = html.replace(m[0], m[0] + '\n' + TAG);
  console.log('+ shim <head> başına eklendi');
  changed = true;
} else console.log('= shim zaten var');

const baseRe = /var\s+BASE\s*=\s*["']https:\/\/claude\.ai\/[^"']*["']\s*;?/g;
const n = (html.match(baseRe) || []).length;
if (n) {
  html = html.replace(baseRe, 'var BASE=location.origin+location.pathname;');
  console.log(`+ BASE satırı değiştirildi (${n})`);
  changed = true;
} else if (/var\s+BASE\s*=\s*location\.origin/.test(html)) console.log('= BASE zaten düzeltilmiş');
else console.warn('! BASE satırı bulunamadı, elle kontrol et');

if (changed) fs.writeFileSync(file, html);

html.split('\n').forEach((line, i) => {
  if (/claude/i.test(line) && !line.includes('/shim.js') && !/claude\.use/.test(line)) {
    console.warn(`! satır ${i + 1}: "Claude" geçiyor -> ${line.trim().slice(0, 140)}`);
  }
});
