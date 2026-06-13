#!/usr/bin/env bash
# Install global `solarch` from the monorepo — no npm registry required.
# Usage: ./scripts/install-cli.sh
# Then from any folder: solarch connect

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm required — npm i -g pnpm" >&2
  exit 1
fi

echo "→ Building @solarch/ast-core + @solarch/cli…"
pnpm --filter @solarch/ast-core --filter @solarch/cli build

echo "→ Linking solarch globally (pnpm link --global)…"
(cd packages/cli && pnpm link --global)

echo ""
echo "✓ Done. Test with:"
echo "  solarch --version"
echo "  cd your-nestjs-repo && solarch connect"
