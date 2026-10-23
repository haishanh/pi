# Node CLI trimming handoff

## Context and agreed scope

This repository is [haishanh/pi](https://github.com/haishanh/pi), a fork of
[earendil-works/pi](https://github.com/earendil-works/pi). This work is on branch
`trim`, based on `936e5f40a` before the trimming changes.

The requested outcome is a smaller Node/npm CLI with only `openai-codex` and
`github-copilot` as built-in providers, bundling JavaScript dependencies wherever
practical. The user explicitly chose to:

- Keep the shared AI library and unbundled SDK behavior unchanged.
- Optimize the Node/npm distribution, not the Bun standalone distribution.
- Keep custom provider extensions supported.
- Leave native addons and assets requiring external files outside the JS bundle.

This is a CLI bundle optimization, not a repository-wide provider removal or a
minimal npm installation. Do not broaden that scope without confirmation.

## Build and runtime

The repository is an npm-workspaces TypeScript monorepo. The root build compiles
workspace dependencies before `packages/coding-agent`.

The coding-agent build runs TypeScript compilation and asset copying, then
`scripts/build-coding-agent-bundle.mjs` uses esbuild to produce split ESM bundles
under `packages/coding-agent/dist/bundle/`.

The installed `pi` command points to `dist/bundle/cli.js`. Its Node launcher enables
the compile cache and loads `cli-runtime.js`. Node >=22.19.0 is required.
The published SDK entry remains `dist/index.js`, outside the specialized bundle.
The exported RPC subprocess entry uses the specialized bundle.

Bun standalone executables have a separate `dist/bun/cli.js` entry and
`bun build --compile` pipeline. That path was not changed.

## Implementation

| File | Responsibility |
| --- | --- |
| `scripts/coding-agent-bundle-profile.mjs` | In-memory provider specialization for the Node esbuild pipeline. |
| `scripts/build-coding-agent-bundle.mjs` | Applies the profile, bundles jiti/Babel, selects lazy OAuth entries, and externalizes native dependencies. |
| `scripts/coding-agent-bundle-profile.test.mjs` | Seven focused regression tests using transpiled repository sources. |

The profile uses the existing TypeScript dependency's `typescript/unstable/sync`
and AST APIs to parse selected compiled JS modules. It changes only the contents
returned to esbuild; it does not rewrite the shared AI source, generated source,
or unbundled output files.

It narrows provider factories and generated model catalogs, the compatibility API
registry and legacy aliases, and OAuth loader exports. It also removes the
automatically registered llama.cpp extension from the Node bundle while keeping
codemode, tool-search, and MCP extensions.

Important details:

- Copilot needs Anthropic Messages, OpenAI Completions, and OpenAI Responses APIs.
  Removing the standalone Anthropic/OpenAI providers does not make those APIs
  removable. Codex also needs OpenAI Codex Responses.
- Radius is not a default built-in provider, but its factory and lazy OAuth entry
  remain for explicitly configured custom Radius gateways.
- `ModelRuntime` imports OpenRouter's catalog-personalization helper separately
  from its provider factory. The profile keeps that helper while pruning the
  OpenRouter factory and catalog imports.
- The extension virtual modules use the narrowed catalog and compatibility API
  registry. Extensions can still register providers with retained protocols or
  supply their own stream implementations.
- Both jiti entry paths resolve to its static transform, including Babel in the
  lazily loaded extension-loader chunk instead of requiring external `jiti`.
- Photon, `bufferutil`, `utf-8-validate`, and `kerberos` are explicit externals.
  `supports-color` is an allowed optional external when unavailable.
  WASM files and other package assets are not made self-contained by this work.
- Worker placement and codemode's builtin-only import checks remain enforced.
  OAuth loader specialization checks that retained flows have lazy bundle entries.
- The transformation checks expected source structures and fails the build when
  they no longer match. Upstream refactors may require updating the profile.

## Local commands

From the repository root, on a fresh checkout:

```sh
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
```

Hydration fetches public model metadata. The offline build needs that generated
data to exist; "offline" means it does not refresh the data itself. The JSON data
under `packages/ai/src/providers/data/` is gitignored. Do not stage it.

From `packages/coding-agent`, after workspace dependencies have been built:

```sh
npm run build
node dist/bundle/cli.js
```

To rebuild only the bundle when compiled output is already current:

```sh
node ../../scripts/build-coding-agent-bundle.mjs
```

Use `/login` inside the CLI to authenticate. Do not use `../../pi-test.sh` to
evaluate trimming: it runs the untrimmed TypeScript source.

Follow `AGENTS.md`: get permission before running build commands in a future
session, install without lifecycle scripts, and never commit unless requested.

## Results and verification

On the same local model data, reported JS bundle output changed from approximately
8.8 MiB / 82 files to 7.4 MiB / 56 files, despite also including jiti/Babel.
This is about a 16% bundle reduction. These are not npm installation sizes;
the full AI dependency remains installed.

The following passed during this work:

```sh
# Repository root
node --test scripts/coding-agent-bundle-profile.test.mjs
npm run check

# packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" \
  --run test/model-runtime-auth-options.test.ts \
  test/agent-session-dynamic-provider.test.ts
```

The focused suites passed seven profile tests and sixteen existing runtime tests.
Do not run the full Vitest suite directly; follow `AGENTS.md` for test selection.

A temporary smoke script also copied the bundle outside the repository dependency
tree and verified CLI version/model listing, the two default runtime providers,
and loading a custom TypeScript provider through bundled jiti and virtual modules.
The custom provider returned a synthetic response without calling a real model.
That temporary script was removed; it is not a committed regression test.

No real model inference or paid provider calls were used for validation. The Bun
path and non-macOS runtimes were not exercised in this session.

## Authentication troubleshooting

The model selector can show a generic cached-model warning when credential
refresh fails, even when the public model-catalog endpoint is healthy. Reveal the
underlying error with:

```sh
# packages/coding-agent
node dist/bundle/cli.js update --models
```

A reported `github-copilot` OAuth refresh failure with HTTP 401 / "Bad credentials"
was diagnosed as rejected authentication, not a missing bundled module. The
recommended recovery was `/logout`, select GitHub Copilot, then `/login` and
reauthorize. Successful recovery was not confirmed in the conversation.
An isolated refresh with clean local state succeeded. Never include credentials
or auth-file contents in diagnostics or commits.

## Possible follow-up work

These are opportunities, not approved additional scope:

- Make the detached-bundle/custom-provider smoke check a persistent regression.
- Measure output contributions and installed dependency size separately before
  choosing further cuts.
- If a minimal npm install is desired, design separate packaging; trimming JS
  alone cannot remove dependencies required by the preserved AI library/SDK.
- Exercise login, streaming, workers, and asset loading across supported platforms.
- Consider embedding/copying WASM assets, or reducing retained Radius/OpenRouter
  compatibility paths, only after confirming the resulting functionality changes.
- Improve selector warnings to expose the underlying provider error safely.

Read `AGENTS.md` before continuing. Preserve unrelated worktree changes, stage only
your own explicit paths, and do not add changelog entries on `trim`.
