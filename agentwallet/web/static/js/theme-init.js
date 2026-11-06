// Applies the saved theme before first paint (classic script, loaded in <head>).
(function () {
  try {
    var t = localStorage.getItem('aw.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow prefers-color-scheme */ }
})();
