/** Fill agent'ı için SALT-OKUNUR codebase keşif araçları — opencode / Claude Code'un
 *  read/grep/glob araçlarına BİREBİR uyarlanmış (isim + parametre + çıktı formatı), çünkü
 *  modeller bu standart araçları/formatları eğitiminden TANIR → daha iyi kullanır. Kapalı
 *  bağlam (curated apiSurface) karmaşık entity-inşa vakalarında yetmiyordu; bu araçlar modele
 *  Cursor/Claude Code gibi gerçek kodu keşfetme yeteneği verir: entity'yi TAM oku, benzer
 *  metodun nasıl yazıldığını gör, kullanım pattern'i ara — SONRA yaz.
 *
 *  opencode'tan farklar (bilinçli): yollar proje-göreli + rootDir'in src/ ağacına KAPSAMLI
 *  (üretilen projede güvenlik; mutlak yol/traversal yok). Saf node:fs (ekstra dep yok). */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, extname, basename, dirname } from "node:path";

const DEFAULT_READ_LIMIT = 2000; // opencode ile aynı
const MAX_LINE_LENGTH = 2000;
const MAX_BYTES = 50 * 1024;
const MAX_GREP_MATCHES = 100;
const MAX_GLOB = 300;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);
const READABLE_EXT = new Set([".ts", ".tsx", ".json"]);

/** glob deseni → RegExp (`**`, `*`, `?`, `{a,b}` desteklenir). Tam yol eşler. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end > i) {
        re += "(?:" + glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("|") + ")";
        i = end;
      } else re += "\\{";
    } else re += /[.+^$()|[\]\\]/.test(c) ? "\\" + c : c;
  }
  return new RegExp("^" + re + "$");
}

/** rootDir/src altındaki TÜM kaynak dosyaları (özyinelemeli) — SKIP_DIRS hariç. */
function walkSource(rootDir: string, cap = 4000): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= cap) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= cap) return;
      if (SKIP_DIRS.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else if (st.isFile() && READABLE_EXT.has(extname(name))) out.push(abs);
    }
  };
  walk(join(rootDir, "src"));
  return out;
}

/** Proje-göreli yolu rootDir içine güvenle çöz (traversal/okunamaz uzantı → null). */
function safeResolve(rootDir: string, rel: string): string | null {
  const cleaned = rel.replace(/^\.?\/+/, "").trim();
  if (!cleaned) return null;
  const abs = resolve(rootDir, cleaned);
  const rootAbs = resolve(rootDir);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + "/")) return null;
  if (!READABLE_EXT.has(extname(abs))) return null;
  return abs;
}

function relPathOf(rootDir: string, abs: string): string {
  return relative(resolve(rootDir), abs) || abs;
}

/** read — bir dosyayı satır-numaralı oku (offset/limit). opencode formatı: `<line>: <content>`.
 *  Dosya yoksa benzer adları önerir (miss). Uzun satır + büyük dosya tavanlı. */
export function read(rootDir: string, filePath: string, offset?: number, limit?: number): string {
  const abs = safeResolve(rootDir, filePath);
  if (!abs) return `cannot read "${filePath}": path must be a project-relative .ts/.json file inside src/`;
  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    // miss: aynı dizinde benzer adlar öner
    const dirAbs = safeResolve(rootDir, dirname(filePath)) ?? join(rootDir, "src");
    const base = basename(filePath).toLowerCase();
    let near: string[] = [];
    try {
      near = readdirSync(dirAbs).filter((n) => n.toLowerCase().includes(base) || base.includes(n.toLowerCase())).slice(0, 3);
    } catch {
      /* yok */
    }
    return `file not found: ${filePath}` + (near.length ? `\nDid you mean: ${near.join(", ")}? (use glob/grep to find the right path)` : "");
  }
  if (content.length > MAX_BYTES) content = content.slice(0, MAX_BYTES) + "\n… (file truncated at 50 KB)";
  const all = content.split("\n");
  const start = Math.max(0, (offset ?? 1) - 1);
  const end = Math.min(all.length, start + (limit ?? DEFAULT_READ_LIMIT));
  const numbered = all.slice(start, end).map((l, i) => {
    const line = l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) + "… (line truncated)" : l;
    return `${start + i + 1}: ${line}`;
  });
  const head = `${relPathOf(rootDir, abs)} (lines ${start + 1}-${end} of ${all.length}):`;
  const tail = end < all.length ? `\n… (${all.length - end} more lines — call read again with offset ${end + 1})` : "";
  return `${head}\n${numbered.join("\n")}${tail}`;
}

/** grep — src/ ağacında regex ara. opencode formatı: `Found N matches`, dosyaya göre gruplu
 *  `path:` + `  Line N: text`. include = dosya-adı glob filtresi ("*.entity.ts"). */
export function grep(rootDir: string, pattern: string, include?: string): string {
  const p = pattern.trim();
  if (!p) return "pass a non-empty regex pattern";
  let re: RegExp;
  try {
    re = new RegExp(p);
  } catch {
    re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); // geçersiz regex → literal
  }
  const inc = include?.trim() ? globToRegExp(include.trim()) : null;
  const byFile = new Map<string, { line: number; text: string }[]>();
  let total = 0;
  for (const abs of walkSource(rootDir)) {
    if (total >= MAX_GREP_MATCHES) break;
    const rp = relPathOf(rootDir, abs);
    if (inc && !inc.test(basename(rp))) continue;
    let lines: string[];
    try {
      lines = readFileSync(abs, "utf8").split("\n");
    } catch {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      if (total >= MAX_GREP_MATCHES) break;
      if (re.test(lines[i]!)) {
        if (!byFile.has(rp)) byFile.set(rp, []);
        byFile.get(rp)!.push({ line: i + 1, text: lines[i]!.trim().slice(0, MAX_LINE_LENGTH) });
        total++;
      }
    }
  }
  if (total === 0) return `No matches for /${p}/${include ? ` in ${include}` : ""}`;
  const hasMore = total >= MAX_GREP_MATCHES;
  const out = [`Found ${total} matches${hasMore ? " (more available)" : ""}`];
  for (const [rp, ms] of byFile) {
    out.push("", `${rp}:`);
    for (const m of ms) out.push(`  Line ${m.line}: ${m.text}`);
  }
  if (hasMore) out.push("", "(Results truncated — use a more specific pattern or include filter.)");
  return out.join("\n");
}

/** glob — src/ ağacında dosya-adı deseni eşle ("**\/*.entity.ts", "video/*.ts"). Eşleşen
 *  proje-göreli yolları döndürür. opencode glob formatı. */
export function glob(rootDir: string, pattern: string): string {
  const pat = pattern.trim();
  if (!pat) return "pass a non-empty glob pattern";
  const re = globToRegExp(pat.replace(/^\.?\/+/, "").replace(/^src\//, "")); // src/ kökü örtük
  const matched = walkSource(rootDir)
    .map((abs) => relPathOf(rootDir, abs))
    .filter((rp) => re.test(rp) || re.test(rp.replace(/^src\//, "")));
  if (matched.length === 0) return `No files matching "${pattern}"`;
  const shown = matched.slice(0, MAX_GLOB);
  const more = matched.length > MAX_GLOB ? `\n… (${matched.length - MAX_GLOB} more)` : "";
  return shown.join("\n") + more;
}
