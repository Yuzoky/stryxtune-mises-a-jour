// Thème choisi sur ce téléphone, appliqué avant l'affichage (pas de flash de couleurs).
'use strict';

const Themes = (() => {
  const KEY = 'bkplanning-theme';
  const LIST = [
    { id: 'auto', label: 'Automatique', a: '#f5ebdc', b: '#170d08' },
    { id: 'creme', label: 'Crème', a: '#f5ebdc', b: '#d63a10' },
    { id: 'sombre', label: 'Sombre', a: '#170d08', b: '#ff8732' },
    { id: 'nuit', label: 'Nuit étoilée', a: '#05050a', b: '#ffd60a' },
    { id: 'ocean', label: 'Océan', a: '#eaf2fb', b: '#1f6fd1' },
    { id: 'foret', label: 'Forêt', a: '#e9f1e6', b: '#2f7d3a' },
    { id: 'rose', label: 'Framboise', a: '#f9ecef', b: '#c2185b' },
  ];
  const dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let pref = 'auto';
  try { pref = localStorage.getItem(KEY) || 'auto'; } catch { /* stockage indisponible */ }
  if (!LIST.some((t) => t.id === pref)) pref = 'auto';

  const resolved = () => (pref === 'auto' ? (dark && dark.matches ? 'sombre' : 'creme') : pref);
  function apply() {
    const id = resolved();
    document.documentElement.dataset.theme = id;
    // Barres du téléphone (heure, boutons) assorties au thème.
    const bars = { creme: '#3d1a0b', sombre: '#24150e', nuit: '#05050a', ocean: '#10345e', foret: '#1d3b22', rose: '#4a1530' }[id];
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = bars;
    if (window.BKAndroid && window.BKAndroid.setBars) window.BKAndroid.setBars(bars);
  }
  function set(id) {
    pref = LIST.some((t) => t.id === id) ? id : 'auto';
    try { localStorage.setItem(KEY, pref); } catch { /* rien */ }
    apply();
  }
  if (dark && dark.addEventListener) dark.addEventListener('change', () => { if (pref === 'auto') apply(); });
  apply();
  return { LIST, set, get: () => pref, apply };
})();
