/** Revizyon zaman çizelgesi + "update var" kararı.
 *
 *  workspaceState'te saklanır (Memento). vscode'a yalnız TİP olarak bağımlıdır —
 *  runtime import yok, vitest sahte Memento ile test eder. */

import type { Memento } from "vscode";

export interface RevisionEntry {
  revision: number;
  /** ISO zaman — eklentinin bu revizyonu İLK gördüğü an. */
  seenAt: string;
  nodes: number;
  edges: number;
}

const REVISIONS_KEY = "solarch.revisions";
const LAST_ACK_KEY = "solarch.lastAckRevision";
const MAX_ENTRIES = 30;

export class RevisionLog {
  constructor(private readonly memento: Memento) {}

  entries(): RevisionEntry[] {
    return this.memento.get<RevisionEntry[]>(REVISIONS_KEY, []);
  }

  /** Yeni revizyon gözlemlendiyse kaydet; "update var" kararı için true döner.
   *  Karar: revizyon, kullanıcının son onayladığından (ack) ileri mi? */
  observe(revision: number, nodes: number, edges: number): boolean {
    const list = this.entries();
    const known = list.some((e) => e.revision === revision);
    if (!known) {
      list.unshift({ revision, seenAt: new Date().toISOString(), nodes, edges });
      list.sort((a, b) => b.revision - a.revision);
      void this.memento.update(REVISIONS_KEY, list.slice(0, MAX_ENTRIES));
    }
    return revision > this.lastAck();
  }

  lastAck(): number {
    return this.memento.get<number>(LAST_ACK_KEY, -1);
  }

  /** Kullanıcı durumu gördü — bir sonraki artışa kadar "update var" sönsün. */
  ack(revision: number): void {
    void this.memento.update(LAST_ACK_KEY, revision);
  }
}
