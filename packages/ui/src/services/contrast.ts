/**
 * WCAG contrast helpers for colours the app does not control through CSS tokens
 * (terminal palettes, user-picked colours). Accepts `#rrggbb`, `#rgb` and
 * `rgb()/rgba()` strings; anything else is treated as unparseable.
 */

export type Rgb = readonly [number, number, number];

export function parseColor(input: string): Rgb | null {
  const s = input.trim().toLowerCase();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const h = hex[1]!.length === 3 ? hex[1]!.split('').map(c => c + c).join('') : hex[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const fn = s.match(/^rgba?\(([^)]+)\)$/);
  if (fn) {
    const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(n => Number.isFinite(n))) {
      return [parts[0]!, parts[1]!, parts[2]!];
    }
  }
  return null;
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** True when the colour is `transparent` or an rgba() with zero alpha. */
export function isTransparent(color: string): boolean {
  const s = color.trim().toLowerCase();
  if (s === 'transparent') return true;
  const m = s.match(/^rgba\(([^)]+)\)$/);
  if (!m) return false;
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
  return parts.length === 4 && Number(parts[3]) === 0;
}

/**
 * Shift `fg` toward black or white (whichever side of `bg` has room) until it
 * reaches `minRatio` against `bg`. Mirrors what xterm's `minimumContrastRatio`
 * does at render time, so previews show the colours the terminal will draw.
 * Unparseable input is returned unchanged.
 */
export function ensureContrast(fg: string, bg: string, minRatio: number): string {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b || contrastRatio(f, b) >= minRatio) return fg;
  const darken = luminance(b) > 0.5;
  const target: Rgb = darken ? [0, 0, 0] : [255, 255, 255];
  for (let step = 1; step <= 20; step++) {
    const t = step / 20;
    const mixed: Rgb = [0, 1, 2].map(i => f[i]! + (target[i]! - f[i]!) * t) as unknown as Rgb;
    if (contrastRatio(mixed, b) >= minRatio) return toHex(mixed);
  }
  return toHex(target);
}
