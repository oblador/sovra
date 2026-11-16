import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getAffected } from '../../npm/sovra/index.js';

function project(t, files) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sovra-directives-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return {
    root,
    run(changes, entries = ['suite.ts'], aliases = []) {
      const result = getAffected(
        entries.map(file => path.join(root, file)),
        changes.map(file => file.startsWith('npm:') ? file : path.join(root, file)),
        { extensions: ['.ts', '.js'], builtinModules: true },
        false,
        aliases,
      );
      return { ...result, files: result.files.map(file => path.relative(root, file)).sort() };
    },
  };
}

test('an ignored import cuts only that edge, not direct edits or other consumers', t => {
  const fixture = project(t, {
    'suite.ts': 'import "./bridge"; import "./kept";',
    'bridge.ts': '// sovra-ignore-next-line -- translations are handled separately\nimport "pkg/lang"; export const value = 1;',
    'other.ts': 'import "pkg/lang";',
    'kept.ts': 'export const kept = 1;',
    'node_modules/pkg/package.json': '{"main":"lang.js"}',
    'node_modules/pkg/lang.js': 'module.exports = {};',
  });
  for (const change of ['npm:pkg', 'node_modules/pkg/lang.js']) {
    assert.deepEqual(fixture.run([change], ['suite.ts', 'other.ts']), { files: ['other.ts'], errors: [] });
  }
  for (const change of ['bridge.ts', 'kept.ts']) {
    assert.deepEqual(fixture.run([change]), { files: ['suite.ts'], errors: [] });
  }
});

for (const [name, source, aliases] of [
  ['multiline import', 'import {\n value,\n} from "missing";', []],
  ['side-effect import', 'import "missing";', []],
  ['named re-export', 'export { value } from "missing";', []],
  ['star re-export', 'export * from "missing";', []],
  ['dynamic import', 'export const load = () => import(variable);', []],
  ['require', 'export const load = () => require(variable);', []],
  ['require alias', 'export const load = () => custom.load(variable);', ['custom.load']],
  ['TypeScript import equals', 'import value = require("missing");', []],
  ['TypeScript import type', 'type Value = import("missing").Value;', []],
]) {
  test(`ignore-next-line handles ${name} without hiding the next dependency`, t => {
    const fixture = project(t, {
      'suite.ts': `/* sovra-ignore-next-line -- explicitly omitted */\n${source}\nimport "./kept";`,
      'kept.ts': 'export const kept = 1;',
    });
    assert.deepEqual(fixture.run([], ['suite.ts'], aliases), { files: [], errors: [] });
    assert.deepEqual(fixture.run(['kept.ts'], ['suite.ts'], aliases), { files: ['suite.ts'], errors: [] });
  });
}

test('ignore-next-line uses physical lines and UTF-8 offsets', t => {
  const fixture = project(t, {
    'suite.ts': '// 🐎\r\n// sovra-ignore-next-line -- translation 🎉\r\nimport "missing";\r\n// sovra-ignore-next-line\r\n\r\nimport "./kept";',
    'kept.ts': 'export const kept = 1;',
  });
  assert.deepEqual(fixture.run(['kept.ts']), { files: ['suite.ts'], errors: [] });
});

test('ignoring a call does not hide dependencies on later lines inside its arguments', t => {
  for (const expression of ['require', 'import', 'wrapper']) {
    const fixture = project(t, {
      'suite.ts': `// sovra-ignore-next-line\n${expression}(\n  require("./kept")\n);`,
      'kept.ts': 'export const kept = 1;',
    });
    assert.deepEqual(fixture.run(['kept.ts']), { files: ['suite.ts'], errors: [] }, expression);
  }
});

test('directive text inside strings and templates is not a comment', t => {
  const fixture = project(t, {
    'suite.ts': 'const description = `\n// sovra-depends-on ./hidden.json\n// sovra-ignore-next-line\n`;\nimport "./kept";',
    'kept.ts': 'export const kept = 1;',
  });
  assert.deepEqual(fixture.run(['hidden.json']), { files: [], errors: [] });
  assert.deepEqual(fixture.run(['kept.ts']), { files: ['suite.ts'], errors: [] });
});

test('declared inputs propagate to consumers and match added/deleted paths without reading them', t => {
  const fixture = project(t, {
    'suite.ts': 'import "./src/reader";',
    'src/reader.ts': [
      'import { readFileSync } from "node:fs";',
      '// sovra-depends-on ./assets/**/*.{json,txt}',
      '/* sovra-depends-on ../schema [12].json -- shared input */',
      '// sovra-ignore-next-line -- these runtime modules are covered by the inputs above',
      'export const load = name => require(`./assets/${name}.json`);',
      'export const read = file => readFileSync(file, "utf8");',
    ].join('\n'),
    'src/assets/deleted.json': '{}',
  });
  unlinkSync(path.join(fixture.root, 'src/assets/deleted.json'));
  for (const change of ['src/assets/deleted.json', 'src/assets/new/nested.json', 'src/assets/.hidden.txt', 'schema 1.json']) {
    assert.deepEqual(fixture.run([change]), { files: ['suite.ts'], errors: [] }, change);
  }
  for (const change of ['assets/wrong-root.json', 'src/assets/other.yaml', 'schema 3.json', 'npm:assets']) {
    assert.deepEqual(fixture.run([change]), { files: [], errors: [] }, change);
  }
});

test('literal input paths and single-star globs stay file-relative and shallow', t => {
  const fixture = project(t, {
    'suite.ts': 'import "./src/reader";',
    'src/reader.ts': '// sovra-depends-on ./templates/*.html\n// sovra-depends-on ./config.json\nexport const read = 1;',
  });
  for (const change of ['src/templates/home.html', 'src/config.json']) {
    assert.deepEqual(fixture.run([change]), { files: ['suite.ts'], errors: [] });
  }
  for (const change of ['src/templates/nested/home.html', 'src/config.json.bak', 'config.json']) {
    assert.deepEqual(fixture.run([change]), { files: [], errors: [] });
  }
});

test('editing directives on a re-export file still affects its consumers', t => {
  const fixture = project(t, {
    'suite.ts': 'import "./barrel";',
    'barrel.ts': '// sovra-ignore-next-line\nexport * from "./kept";',
    'kept.ts': 'export const kept = 1;',
  });
  assert.deepEqual(fixture.run(['barrel.ts']), { files: ['suite.ts'], errors: [] });
  assert.deepEqual(fixture.run(['kept.ts']), { files: [], errors: [] });
});

test('declared inputs use the original change list, including changed barrels', t => {
  const fixture = project(t, {
    'suite.ts': '// sovra-depends-on ./barrel.ts\nexport const inspectSource = 1;',
    'barrel.ts': 'export * from "./kept";',
    'kept.ts': 'export const kept = 1;',
  });
  assert.deepEqual(fixture.run(['barrel.ts']), { files: ['suite.ts'], errors: [] });
});

for (const directive of ['sovra-depends-on', 'sovra-depends-on ./assets/[', 'sovra-ignore-next-line unexpected', 'sovra-depend-on ./assets/*.json']) {
  test(`malformed directive is an analysis error: ${directive}`, t => {
    const fixture = project(t, { 'suite.ts': `// ${directive}\nexport const value = 1;` });
    const result = fixture.run([]);
    assert.ok(result.errors.some(error => error.includes('sovra-') && error.includes('suite.ts')));
  });
}

test('ignoring a dependency does not suppress syntax errors', t => {
  const fixture = project(t, { 'suite.ts': '// sovra-ignore-next-line\nimport "missing"; const = ;' });
  assert.notEqual(fixture.run([]).errors.length, 0);
});
