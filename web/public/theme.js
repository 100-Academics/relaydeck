(() => {
  const key = 'relaydeck.theme';
  const apply = value => {
    const theme = value === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.documentElement.style.backgroundColor = theme === 'dark' ? '#101722' : '#f5f7fb';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101722' : '#f5f7fb');
    window.dispatchEvent(new Event('relaydeck-theme-change'));
  };
  let saved;
  try { saved = localStorage.getItem(key); } catch {}
  apply(saved);
  window.RelaydeckTheme = {
    set(theme) { try { localStorage.setItem(key, theme); } catch {} apply(theme); },
  };
  window.addEventListener('storage', event => { if (event.key === key) apply(event.newValue); });
})();
