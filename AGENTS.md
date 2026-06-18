# Repository Guidelines

## Project Structure & Module Organization

This is a Windows reader built with Electron, Vite, React, and TypeScript.

- `src/` contains the renderer app: `App.tsx`, UI views in `components/`, reader implementations in `components/readers/`, shared helpers in `lib/`, and renderer contracts in `types.ts`.
- `electron/` contains the main process, preload bridge, SQLite repository, and import pipeline. These files are CommonJS (`*.cjs`) because Electron loads `electron/main.cjs` directly.
- `scripts/` contains the Vite/Electron dev launcher and database diagnostics.
- `dist/`, `node_modules/`, logs, and environment files are ignored and should not be committed.

## Build, Test, and Development Commands

- `npm ci` installs the locked dependency set from `package-lock.json`.
- `npm run dev` starts Vite on `127.0.0.1:5173`, then launches Electron against that dev server.
- `npm run build` runs TypeScript checking with `tsc --noEmit` and builds the renderer with Vite.
- `npm run preview` serves the built renderer locally for quick inspection.
- `npm run doctor` checks the user database under the Electron app data directory and reports import/cache diagnostics.
- `npm run rebuild:native` rebuilds `better-sqlite3` for the current Electron runtime.

## Coding Style & Naming Conventions

Use strict TypeScript in `src/`, React function components, named exports, two-space indentation, double quotes, and semicolons. Name components in PascalCase (`LibraryView.tsx`) and variables/functions in camelCase. Keep shared interfaces in `src/types.ts` and prefer explicit union types for reader state and IPC payloads.

Keep Electron-only APIs in `electron/` and expose renderer functionality through the preload bridge. Do not import Node modules directly from React components.

## Testing Guidelines

No automated test runner is configured yet. For functional changes, run `npm run build` and smoke test `npm run dev`. Exercise affected import paths, especially TXT, PDF, EPUB, and image-folder imports when touching `electron/importer.cjs`, reader views, or database code. Run `npm run doctor` after cache, migration, or SQLite schema changes.

If tests are added, prefer colocated `*.test.ts` or `*.test.tsx` files and add an `npm test` script before relying on them in pull requests.

## Commit & Pull Request Guidelines

Git history currently contains only `Initial commit`, so no detailed commit convention is established. Use short, imperative commit subjects such as `Add EPUB import diagnostics` or `Fix reader progress persistence`.

Pull requests should include the user-facing change, affected formats or screens, commands run, and screenshots for visible UI changes. Link related issues when available and call out native dependency or data migration impact.
