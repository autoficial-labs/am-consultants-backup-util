import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Block the browser's own context menu and reload shortcuts so the window feels like an app.
if (import.meta.env.PROD) {
  window.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest('input, textarea, .selectable')) e.preventDefault();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F5' || (e.ctrlKey && (e.key === 'r' || e.key === 'R' || e.key === 'p' || e.key === 'P'))) e.preventDefault();
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
