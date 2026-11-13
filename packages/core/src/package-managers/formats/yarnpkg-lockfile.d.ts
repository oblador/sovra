declare module '@yarnpkg/lockfile' {
  export interface LockManifest {
    version: string;
    resolved?: string;
    integrity?: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }
  export interface ParseResult {
    type: 'success' | 'merge' | 'conflict';
    object: Record<string, LockManifest>;
  }
  export function parse(content: string): ParseResult;
  export function stringify(obj: unknown): string;
}
