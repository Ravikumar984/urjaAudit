// Runs before first paint so the saved theme is applied without a flash.
(function () {
  try {
    var t = localStorage.getItem('urja_theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* ignore */ }
})();