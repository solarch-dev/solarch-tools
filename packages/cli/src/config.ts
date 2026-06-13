/** CLI configuration — two layers:
 *  1. Identity: ~/.solarch/credentials (mode 600 JSON) — machine-wide API key.
 *  2. Project link: <repo>/solarch.json — projectId + scan settings + bindings.
 *     Match cache: <repo>/.solarch/map.json (may be gitignored). */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_API_URL = "https://app.solarch.dev/api/v1";

/* ── identity (~/.solarch/credentials) ───────────────────────────── */

export interface Credentials {
  apiUrl: string;
  apiKey: string;
}

function credentialsPath(): string {
  return join(homedir(), ".solarch", "credentials");
}

export function readCredentials(): Credentials | null {
  const p = credentialsPath();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<Credentials>;
    if (!raw.apiKey) return null;
    return { apiUrl: raw.apiUrl ?? DEFAULT_API_URL, apiKey: raw.apiKey };
  } catch {
    return null;
  }
}

export function writeCredentials(creds: Credentials): string {
  const p = credentialsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600); // dosya zaten varsa da izinleri sık
  return p;
}

/* ── proje bağı (solarch.json) ───────────────────────────────────── */

export interface BindingConfig {
  /** "src/entities/user.entity.ts#User" */
  source: string;
  /** "src/dto/user.dto.ts#UserDto" */
  target: string;
  /** "all" veya alan adı listesi. */
  fields: "all" | string[];
}

export interface ProjectConfig {
  projectId: string;
  projectName?: string;
  apiUrl?: string;
  include?: string[];
  exclude?: string[];
  bindings: BindingConfig[];
}

export function projectConfigPath(rootDir: string): string {
  return join(resolve(rootDir), "solarch.json");
}

export function readProjectConfig(rootDir: string): ProjectConfig | null {
  const p = projectConfigPath(rootDir);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<ProjectConfig>;
    // projectId boş olabilir: `solarch bind` link'ten önce binding-only config yazar.
    return {
      projectId: raw.projectId ?? "",
      projectName: raw.projectName,
      apiUrl: raw.apiUrl,
      include: raw.include,
      exclude: raw.exclude,
      bindings: raw.bindings ?? [],
    };
  } catch {
    return null;
  }
}

export function writeProjectConfig(rootDir: string, config: ProjectConfig): string {
  const p = projectConfigPath(rootDir);
  writeFileSync(p, JSON.stringify(config, null, 2) + "\n");
  return p;
}

/* ── eşleştirme cache'i (.solarch/map.json) ──────────────────────── */

/** Kod node key'i → cloud node id eşlemesi. Yeniden adlandırmalarda eşleşme
 *  kararlı kalsın diye diff her koşuda günceller. */
export type MatchCache = Record<string, string>;

function mapCachePath(rootDir: string): string {
  return join(resolve(rootDir), ".solarch", "map.json");
}

export function readMatchCache(rootDir: string): MatchCache {
  const p = mapCachePath(rootDir);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as MatchCache;
  } catch {
    return {};
  }
}

export function writeMatchCache(rootDir: string, cache: MatchCache): void {
  const p = mapCachePath(rootDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cache, null, 2) + "\n");
}

/* ── üretim manifestosu (.solarch/generated.json) ────────────────── */

/** generate'in yazdığı işaretli dosyaların kaydı — işaret kaybı tespiti için.
 *  Dosya yolu → { nodeId?, markers }. Yalnız marker taşıyan dosyalar girer. */
export interface GeneratedManifest {
  [file: string]: { nodeId?: string; markers: number };
}

function manifestPath(rootDir: string): string {
  return join(resolve(rootDir), ".solarch", "generated.json");
}

export function readGeneratedManifest(rootDir: string): GeneratedManifest {
  const p = manifestPath(rootDir);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as GeneratedManifest;
  } catch {
    return {};
  }
}

/** Merge ile yazar — önceki üretimlerin kayıtları korunur, aynı dosya güncellenir. */
export function mergeGeneratedManifest(rootDir: string, entries: GeneratedManifest): void {
  const merged = { ...readGeneratedManifest(rootDir), ...entries };
  const p = manifestPath(rootDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(merged, null, 2) + "\n");
}
