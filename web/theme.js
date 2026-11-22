try {
  const theme = localStorage.getItem('focus-code-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // The system theme is the default when browser storage is unavailable.
}
