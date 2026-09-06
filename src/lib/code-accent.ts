import { hexToHsl } from './theme';

/** Change syntax colours without loading or rebuilding an editor. */
export function applyCodeAccent(hex: string): void {
  if (typeof document === 'undefined' || !hexToHsl(hex)) return;
  document.documentElement.style.setProperty('--code-accent', hex);
  document.documentElement.style.setProperty('--code-keyword', hex);
}
