/** RevisionLog — "update var" kararı ve zaman çizelgesi kalıcılığı.
 *  vscode'a runtime bağımlılığı yok; sahte Memento yeter. */

import { describe, expect, it } from "vitest";
import type { Memento } from "vscode";
import { RevisionLog } from "../src/revision-log.js";

function fakeMemento(): Memento {
  const store = new Map<string, unknown>();
  return {
    keys: () => [...store.keys()],
    get: <T>(key: string, def?: T) => (store.has(key) ? (store.get(key) as T) : (def as T)),
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

describe("RevisionLog", () => {
  it("ilk gözlem: kayıt düşer ve update sayılır (hiç ack yok)", () => {
    const log = new RevisionLog(fakeMemento());
    expect(log.observe(3, 10, 12)).toBe(true);
    expect(log.entries()).toHaveLength(1);
    expect(log.entries()[0]).toMatchObject({ revision: 3, nodes: 10, edges: 12 });
  });

  it("ack sonrası aynı revizyon update sayılmaz, artış yine sayılır", () => {
    const log = new RevisionLog(fakeMemento());
    log.observe(3, 10, 12);
    log.ack(3);
    expect(log.observe(3, 10, 12)).toBe(false); // değişiklik yok
    expect(log.observe(4, 11, 13)).toBe(true); // canvas'ta biri bir şey ekledi
    expect(log.entries().map((e) => e.revision)).toEqual([4, 3]); // yeni üstte
  });

  it("aynı revizyonu iki kez görmek çift kayıt açmaz", () => {
    const log = new RevisionLog(fakeMemento());
    log.observe(5, 1, 1);
    log.observe(5, 1, 1);
    expect(log.entries()).toHaveLength(1);
  });

  it("zaman çizelgesi 30 kayıtla sınırlı", () => {
    const log = new RevisionLog(fakeMemento());
    for (let r = 1; r <= 40; r++) log.observe(r, r, r);
    const entries = log.entries();
    expect(entries).toHaveLength(30);
    expect(entries[0]?.revision).toBe(40); // en yeni üstte
  });
});
