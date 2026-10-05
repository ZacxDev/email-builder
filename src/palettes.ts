/**
 * Email Builder — custom palette proposals (v0.1.2 theme exploration).
 *
 * Each palette overrides the W6 kit's color tokens on the app root; the kit
 * components read `var(--civitai-color-*)`, so a palette is just a token set.
 * Preview any of them in the dev harness with `?palette=<id>&seed=demo`.
 * The email preview itself stays a faithful white email card — palettes
 * theme the app chrome, never the user's email.
 */

export interface Palette {
  id: string;
  name: string;
  blurb: string;
  vars: Record<string, string>;
}

export const PALETTES: Palette[] = [
  {
    id: 'coral-post',
    name: 'Coral Post',
    blurb: 'Navy + coral — matches the listing icon and cover art.',
    vars: {
      '--civitai-color-surface': '#131c36',
      '--civitai-color-surface-2': '#0a1128',
      '--civitai-color-text': '#f7f2e9',
      '--civitai-color-text-dimmed': '#a8b0c8',
      '--civitai-color-border': '#26335c',
      '--civitai-color-primary': '#ff6b4a',
      '--civitai-color-primary-hover': '#ff8266',
    },
  },
  {
    id: 'letterpress',
    name: 'Letterpress',
    blurb: 'Burgundy + cream + gold — a printed-letter editorial feel.',
    vars: {
      '--civitai-color-surface': '#241219',
      '--civitai-color-surface-2': '#170a10',
      '--civitai-color-text': '#f5ead6',
      '--civitai-color-text-dimmed': '#c4a58e',
      '--civitai-color-border': '#4a2432',
      '--civitai-color-primary': '#d9a441',
      '--civitai-color-primary-hover': '#e7b95e',
    },
  },
  {
    id: 'newsroom',
    name: 'Newsroom',
    blurb: 'Deep spruce + mint — calm, typewriter-newsroom energy.',
    vars: {
      '--civitai-color-surface': '#10201b',
      '--civitai-color-surface-2': '#08120e',
      '--civitai-color-text': '#eaf5ef',
      '--civitai-color-text-dimmed': '#93b3a5',
      '--civitai-color-border': '#1f3d33',
      '--civitai-color-primary': '#3ecf8e',
      '--civitai-color-primary-hover': '#5adba2',
    },
  },
  {
    id: 'violet-circuit',
    name: 'Violet Circuit',
    blurb: 'Midnight violet — Civitai-adjacent, electric, after-dark.',
    vars: {
      '--civitai-color-surface': '#1c1433',
      '--civitai-color-surface-2': '#0f0a20',
      '--civitai-color-text': '#efeaff',
      '--civitai-color-text-dimmed': '#a79fd1',
      '--civitai-color-border': '#372a63',
      '--civitai-color-primary': '#8b7bff',
      '--civitai-color-primary-hover': '#a294ff',
    },
  },
];

/**
 * Coral Post, light companion — used only when the host theme is explicitly
 * light (house rule: dark by default, light as an explicit override).
 */
export const CORAL_POST_LIGHT: Record<string, string> = {
  '--civitai-color-surface': '#fffaf3',
  '--civitai-color-surface-2': '#f7ead9',
  '--civitai-color-text': '#1d2440',
  '--civitai-color-text-dimmed': '#5d6579',
  '--civitai-color-border': '#e6d5c0',
  '--civitai-color-primary': '#e8552f',
  '--civitai-color-primary-hover': '#d14a26',
};

/** The shipped theme (v0.1.2, picked by Zacx 2026-10-04). */
export const DEFAULT_PALETTE: Palette = PALETTES[0];

export function paletteById(id: string | null | undefined): Palette | null {
  if (!id) return null;
  return PALETTES.find((p) => p.id === id) ?? null;
}
