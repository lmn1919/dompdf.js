# Contributing to dompdf.js

Thanks for your interest in contributing.

## Before You Start

1. Search existing issues and pull requests before starting new work.
2. For user-facing changes, include a short reproduction case or demo page update when possible.
3. For rendering fixes, describe the expected HTML result and the current PDF difference.

## Development Setup

```bash
npm install
npm run build
npm test
```

Requirements:

- Node.js 18+
- Rust toolchain
- `wasm32-unknown-unknown` target

Install the Rust target if needed:

```bash
rustup target add wasm32-unknown-unknown
```

## Project Areas

- `src/`: TypeScript DOM snapshot and worker pipeline
- `wasm/`: Rust PDF writer and pagination engine
- `examples/`: manual demos and reproduction pages
- `docs/`: migration notes and system documentation

## Pull Request Guidelines

1. Keep pull requests focused.
2. Update docs when changing public behavior or API surface.
3. Add or update verification coverage when fixing renderer bugs.
4. Include screenshots, PDF diffs, or reproduction notes for rendering-related changes.
5. Make sure `npm test` passes locally before opening the PR.

## Commit Style

This repo commonly uses conventional-style prefixes such as:

- `feat:`
- `fix:`
- `docs:`
- `refactor:`
- `chore:`

## Reporting Bugs

When opening an issue, include:

- browser and OS
- minimal HTML/CSS reproduction
- expected PDF result
- actual PDF result
- whether custom fonts or external assets are involved

## Security

Please do not open public issues for vulnerabilities. Follow [SECURITY.md](./SECURITY.md) instead.
