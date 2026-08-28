import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
// The Glass look: index.css is the base, glass.css restyles it under
// html[data-ui-theme="glass"] (see src/themes/registry.ts).
import './themes/glass.css';
import { applyUiTheme } from './themes/registry';

// index.html already carries the attribute; stamping it here too keeps a
// cached or hand-edited html from painting the unstyled base.
applyUiTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
