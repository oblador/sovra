import yaml from 'js-yaml';

type Settings = Record<string, unknown>;

function readSettings(text: string | undefined): Settings {
  if (!text) return {};
  const value = yaml.load(text);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Settings
    : {};
}

function npmrcSettings(text: string | undefined): Settings {
  const settings: Settings = {};
  for (const line of (text ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*([\w-]+)(\[\])?\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1].replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const value = match[3].replace(/\s+[;#].*$/, '').replace(/^(["'])(.*)\1$/, '$2');
    if (match[2]) {
      const previous = settings[key];
      settings[key] = [...(Array.isArray(previous) ? previous : []), value];
    } else {
      settings[key] = value === 'true' ? true : value === 'false' ? false : value;
    }
  }
  return settings;
}

function patterns(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function legacySettings(text: string | undefined): Settings {
  const manifest = JSON.parse(text ?? '{}') as { pnpm?: Settings };
  return Object.fromEntries(Object.entries(manifest.pnpm ?? {}).map(([key, value]) => [
    key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), value,
  ]));
}

/** pnpm package patterns treat everything except `*` literally. */
function compilePattern(pattern: string): RegExp {
  const source = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`);
}

/** Effective package visibility, supplied as data to dependency comparison. */
export interface DependencyLayout {
  linker: 'isolated' | 'hoisted' | 'pnp';
  /** pnpm public hoists; private hoisting does not expose application imports. */
  publicHoistPatterns?: string[];
}

/** Resolve pnpm settings from supplied text, with no filesystem access. */
export function parsePnpmLayout(input: {
  manifest?: string;
  npmrc?: string;
  workspace?: string;
}): Required<DependencyLayout> {
  const settings = {
    ...legacySettings(input.manifest),
    ...npmrcSettings(input.npmrc),
    ...readSettings(input.workspace),
  };
  const nodeLinker = settings.nodeLinker;
  const linker = nodeLinker === 'hoisted' || nodeLinker === 'pnp' ? nodeLinker : 'isolated';
  const publicHoistPatterns = patterns(
    settings.shamefullyHoist === true ? ['*']
      : settings.shamefullyHoist === false ? [] : settings.publicHoistPattern,
  );
  return { linker, publicHoistPatterns };
}

/** Compile once per comparison, then reuse for every affected dependency. */
export function createPublicHoistMatcher(layout: DependencyLayout): (name: string) => boolean {
  if (layout.linker === 'pnp') return () => false;
  if (layout.linker === 'hoisted') return () => true;
  const patterns = layout.publicHoistPatterns ?? [];
  if (patterns.length === 0) return () => false;
  const compiled = patterns.map((pattern) => {
    const negative = pattern.startsWith('!');
    return { negative, regex: compilePattern(negative ? pattern.slice(1) : pattern) };
  });
  // Match @pnpm/matcher: negative-only lists start with everything included;
  // mixed lists are applied in order, so a later positive can re-include a name.
  const initiallyIncluded = compiled.every(({ negative }) => negative);
  return (name) => {
    let included = initiallyIncluded;
    for (const { negative, regex } of compiled) {
      if (regex.test(name)) included = !negative;
    }
    return included;
  };
}
