// deno-lint-ignore-file no-import-prefix no-unversioned-import
/**
 * Builds the npm package from the Deno source using @deno/dnt.
 *
 * Run with:
 *   deno task build:npm
 *
 * Output is written to ./npm/ and is gitignored. The directory is
 * cleared on each run so stale artifacts never bleed through.
 *
 * This script is intentionally explicit about packaging choices because npm
 * publishing is a boundary where accidental config drift is expensive. The
 * comments below explain why the build opts into, or out of, each dnt feature.
 */
import { build, emptyDir } from 'jsr:@deno/dnt';
import denoJson from '../deno.json' with { type: 'json' };

// Start from a clean output directory so removed entry points or metadata do
// not survive from a previous build and confuse package inspection.
await emptyDir('./npm');

await build({
  entryPoints: ['./mod.ts'],
  outDir: './npm',

  // mod.ts uses no Deno-specific globals (no Deno.*, no std/ imports),
  // so no shims are required.
  shims: { deno: false },

  // Type-check the output against Node.js types (the default).
  // This catches any Node vs. browser compat issues at build time.
  typeCheck: "both",

  // Do not run the test suite through Node.js. The tests import
  // jsr:@std/testing/bdd and jsr:@std/expect, which reference Deno-native
  // types (Deno.TestDefinition, Deno.TestContext, etc.) that have no Node.js
  // equivalent. Including them causes dnt to pull those Deno-specific
  // dependencies into the build graph and fail type-checking against Node
  // types. The authoritative test run happens via `deno task test` in CI,
  // which is the correct runtime for these tests.
  test: false,

  package: {
    name: denoJson.name, // "@okikio/wikitext"
    version: denoJson.version,
    description:
      "Event-stream-first wikitext source parser. Produces a structured AST (wikist) extending unist. Works in Deno, Node.js, Bun, and browsers.",
    license: "MIT",
    keywords: [
      "wikitext",
      "wiki",
      "mediawiki",
      "parser",
      "ast",
      "unist",
      "wikist",
      "streaming",
    ],
    repository: {
      type: "git",
      url: "git+https://github.com/okikio/wikitext.git",
    },
    bugs: {
      url: "https://github.com/okikio/wikitext/issues",
    },
    homepage: "https://jsr.io/@okikio/wikitext",

    // dnt auto-generates `main`, `module`, `types`, and `exports` from the
    // declared entry points, so they are intentionally omitted here. Adding
    // them manually would create misleading dead config — dnt overwrites those
    // fields in its output pass regardless of what is specified here.

    // Tells bundlers (webpack, Rollup, esbuild, Vite, …) this package has no
    // side effects on import, enabling full tree-shaking.
    sideEffects: false,

    // Declare the minimum supported Node.js version. Node.js 18 reached EOL
    // in April 2025; targeting 20+ keeps the engines field accurate and
    // prevents installation on unsupported runtimes.
    engines: {
      node: '>=24',
    },
  },

  postBuild() {
    // dnt only handles code and generated package metadata. The project docs
    // and license still need to be copied explicitly so the npm tarball tells
    // the same story as the source repository.
    Deno.copyFileSync('license', 'npm/license');
    Deno.copyFileSync('readme.md', 'npm/readme.md');
    Deno.copyFileSync('changelog.md', 'npm/changelog.md');
  },
});
