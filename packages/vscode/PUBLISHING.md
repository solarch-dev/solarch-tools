# Publishing `solarch-vscode`

How to ship the extension to the VS Code Marketplace. Run everything from
`solarch-tools/packages/vscode`. `node` and `pnpm` must be on PATH.

## Pre-publish gates (do NOT publish until all are true)

1. **Interactive UI verified in a real Extension Development Host.** `pnpm lint`
   / `test` / `smoke` cover types, units and bundle integrity, but NOT the live
   UI. Press **F5**, open a linked NestJS repo against the **production** cloud,
   and confirm by hand:
   - Sign in + Link onboarding (welcome buttons) works.
   - Push / Pull / Generate / **Check Drift** toolbar buttons work.
   - **Bind Entity to DTO**: pick source/target/fields → DTO gets the columns;
     then edit + save the Entity → the DTO updates automatically.
   - Kill network → the view shows the **offline** banner (not blank) and a
     **Retry** row; restore network → Retry recovers.
2. **Production cloud is live.** The extension talks to `https://api.solarch.dev`.
   Sign-in, link, getGraph/getRules, push and codegen must work end-to-end in
   prod (not just locally). A published extension against a dead cloud fails at
   sign-in — worse than not shipping.
3. **Marketplace publisher exists.** The `publisher` in `package.json` is
   `solarch`; that publisher must be created and verified at
   <https://marketplace.visualstudio.com/manage>.
4. **PAT ready.** A Personal Access Token from Azure DevOps (organization =
   the publisher's), scope **Marketplace → Manage**. Keep it secret; never commit it.
5. **Version + CHANGELOG** reflect what ships (currently `0.7.0`).

## Publish

```bash
# one-time per machine: authenticate vsce with your PAT
pnpm dlx @vscode/vsce login solarch

# sanity gates
pnpm lint && pnpm test && pnpm smoke

# build a VSIX and eyeball its contents (LICENSE.txt must be present)
pnpm package
unzip -l solarch-vscode-0.7.0.vsix | grep -i license

# publish (also re-builds via the `package`/`vscode:prepublish` path)
pnpm dlx @vscode/vsce publish --no-dependencies
```

> `--no-dependencies` is required: the runtime deps are `workspace:*` and are
> already inlined into `dist/extension.js` by esbuild (verified by `pnpm smoke`).

To bump and publish in one step instead: `vsce publish minor` (edits the version,
tags, and publishes) — but prefer an explicit version bump + CHANGELOG entry.

## Rollback

The Marketplace cannot truly delete a published version. If a release is bad:

```bash
pnpm dlx @vscode/vsce unpublish solarch.solarch-vscode@0.7.0   # removes that version
```

…then publish a fixed higher version. Users who already installed keep the bad
build until they update, so prefer catching issues at the F5 gate above.

## Soft launch (recommended first)

Before the Marketplace, distribute the `.vsix` directly to dogfood the real UI +
live cloud with no public commitment:

```bash
pnpm package
code --install-extension solarch-vscode-0.7.0.vsix
```

## Deliberate design decisions (not bugs)

- **API key stays in `~/.solarch/credentials` (mode 600), not VS Code
  SecretStorage.** This is intentional: identity and the project link are the
  *same files the CLI uses*, so `solarch login`/`link` in a terminal and the
  extension are fully interchangeable (a documented feature). Moving the key to
  SecretStorage would break that interchange. Revisit only if the interchange
  guarantee is dropped.
- **`"private": true` is kept.** It blocks an accidental `npm publish` to the npm
  registry; `vsce` ignores it and publishes to the Marketplace via the
  `publisher` field regardless.
- **`example_cli_project/` is the `pnpm smoke` fixture but is not coupled to
  `package`** — the fixture may be absent in a clean checkout, so packaging must
  not depend on it. Run `pnpm smoke` (optionally `pnpm smoke <dir>`) manually or
  in CI.
