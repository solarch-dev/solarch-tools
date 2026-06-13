/** Solarch CLI branding — ASCII logo from logo.svg + typography.
 *  Color: #FD6A09 (brand orange). NO_COLOR / pipe → plain text. */

import pc from "picocolors";
import { LOGO_LINES, LOGO_RAMP } from "./logo.generated.js";

export { LOGO_LINES };

const BRAND_RGB = "253;106;9";
const BRAND_DEEP_RGB = "255;87;0";
const MUTED_RGB = "148;163;184";

export function colorsEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

export function brand(s: string): string {
  if (!colorsEnabled()) return s;
  return `\u001b[38;2;${BRAND_RGB}m${s}\u001b[0m`;
}

export function brandDeep(s: string): string {
  if (!colorsEnabled()) return s;
  return `\u001b[38;2;${BRAND_DEEP_RGB}m${s}\u001b[0m`;
}

export function muted(s: string): string {
  if (!colorsEnabled()) return s;
  return `\u001b[38;2;${MUTED_RGB}m${s}\u001b[0m`;
}

function paintChar(ch: string): string {
  const rampIdx = LOGO_RAMP.indexOf(ch);
  if (rampIdx <= 0) return ch;
  const t = rampIdx / (LOGO_RAMP.length - 1);
  if (t >= 0.72) return brandDeep(ch);
  if (t >= 0.38) return brand(ch);
  return muted(ch);
}

/** Colorize generated logo lines by character density. */
export function paintLogo(): string {
  return LOGO_LINES.map((line) => line.split("").map(paintChar).join("")).join("\n");
}

export interface BannerMeta {
  version: string;
  tagline?: string;
}

export function renderBanner(meta: BannerMeta): string {
  const tag = meta.tagline ?? "architecture CLI";
  const title = brand("SOLARCH");
  const sep = muted(" · ");
  const ver = pc.bold(`v${meta.version}`);
  const subtitle = muted("diagram ⟷ code  ·  drift guard  ·  sync");

  return [
    paintLogo(),
    "",
    `     ${title}${sep}${muted(tag)}${sep}${ver}`,
    `     ${muted("─".repeat(44))}`,
    `     ${subtitle}`,
  ].join("\n");
}

export function renderVersionScreen(version: string): string {
  const node = muted(`node ${process.version}`);
  const npm = brand("@solarch/cli");

  return [
    renderBanner({ version, tagline: "architecture CLI" }),
    "",
    `  ${npm} ${pc.bold(`v${version}`)}`,
    `  ${node}`,
    "",
    muted("  https://solarch.dev"),
    "",
    muted("  Start here: ") + brand("solarch connect"),
  ].join("\n");
}
