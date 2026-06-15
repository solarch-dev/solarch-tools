# Solarch Drift Check — GitHub Action

Runs `solarch diff` on every PR/push, uploads the result as **SARIF** so drift
findings show up in **Security → Code scanning** (and inline on the PR), and
**fails the job** when the code has drifted from the architecture.

## Usage

```yaml
# .github/workflows/solarch-drift.yml
name: Solarch Drift
on: [pull_request, push]
permissions:
  contents: read
  security-events: write   # required to upload SARIF
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: solarch-dev/solarch-tools/.github/actions/solarch-drift@main
        with:
          api-key: ${{ secrets.SOLARCH_API_KEY }}
          # working-directory: packages/api   # if solarch.json isn't at the repo root
          # api-url: https://your-self-hosted/api/v1
```

## Prerequisites

- A committed `solarch.json` in the repo (run `solarch link` locally once).
- A Solarch API key (Solarch → Settings → API Keys) stored as the
  `SOLARCH_API_KEY` repository secret.

The action installs `@solarch/cli`, signs in, runs `solarch diff --sarif`,
uploads the SARIF, and exits non-zero when there are drift **errors** (warnings
and info do not fail the build).
