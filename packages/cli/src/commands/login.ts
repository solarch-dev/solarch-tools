import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { SolarchApi } from "../api.js";
import { DEFAULT_API_URL, writeCredentials } from "../config.js";

export interface LoginOptions {
  apiUrl?: string;
  /** Etkileşimsiz kullanım (CI): anahtar bayrak olarak verilir. */
  key?: string;
}

export async function loginCommand(opts: LoginOptions): Promise<void> {
  const apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, "");

  let apiKey = opts.key;
  if (!apiKey) {
    console.log(`Create an API key at ${pc.cyan("Settings → API Keys")} in the Solarch app, then paste it below.`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    apiKey = (await rl.question("API key (slk_...): ")).trim();
    rl.close();
  }

  if (!apiKey?.startsWith("slk_")) {
    console.error(pc.red("Key must start with slk_ — aborting."));
    process.exitCode = 1;
    return;
  }

  // Anahtarı kaydetmeden önce canlı doğrula — yanlış yapıştırma anında yakalanır.
  const api = new SolarchApi({ apiUrl, apiKey });
  try {
    const projects = await api.listProjects();
    const path = writeCredentials({ apiUrl, apiKey });
    console.log(pc.green(`Logged in. Credentials saved to ${path} (chmod 600).`));
    console.log(`You have access to ${pc.bold(String(projects.length))} project(s). Next: ${pc.cyan("solarch link")}`);
  } catch (e) {
    console.error(pc.red(`Login failed: ${(e as Error).message}`));
    process.exitCode = 1;
  }
}
