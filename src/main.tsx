import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
// Interface themes. index.css is the classic look; glass.css is scoped under
// html[data-ui-theme="glass"] and inert otherwise (see src/themes/registry.ts).
import './themes/glass.css';
import { applyUiTheme, readCachedUiTheme } from './themes/registry';

// Stamp the remembered interface theme before the first paint so the login
// screen and the shell never flash the other look; the account pref
// re-applies it after login.
applyUiTheme(readCachedUiTheme());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
