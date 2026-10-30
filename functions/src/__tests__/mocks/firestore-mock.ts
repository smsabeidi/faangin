/**
 * Minimal in-memory Firestore mock. Supports the subset of the Admin SDK the
 * billing handlers actually use: doc get/set (with merge), collection add,
 * basic where(...) + limit queries, and transactions.
 *
 * It is deliberately NOT a general-purpose fake — do not grow it into one.
 * Keep it small enough that a test author can read it in two minutes.
 */

type Dict = Record<string, unknown>;

interface Store {
  // collectionName -> docId -> data
  data: Map<string, Map<string, Dict>>;
  // monotonic counter for `collection.add` auto-ids
  autoId: number;
}

function deepClone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v)) as T;
}

function mergeDeep(base: Dict, patch: Dict): Dict {
  const out: Dict = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v;
  }
  return out;
}

interface Where {
  field: string;
  op: "==" | ">=" | "<=" | ">" | "<";
  value: unknown;
}

export class MockDocRef {
  constructor(
    public readonly store: Store,
    public readonly collectionName: string,
    public readonly id: string,
  ) {}

  get ref(): MockDocRef {
    return this;
  }

  async get(): Promise<MockDocSnap> {
    const col = this.store.data.get(this.collectionName);
    const raw = col?.get(this.id);
    return new MockDocSnap(this, raw !== undefined ? deepClone(raw) : undefined);
  }

  async set(data: Dict, options?: { merge?: boolean }): Promise<void> {
    let col = this.store.data.get(this.collectionName);
    if (!col) {
      col = new Map();
      this.store.data.set(this.collectionName, col);
    }
    const prev = col.get(this.id);
    if (options?.merge && prev) {
      col.set(this.id, mergeDeep(prev, deepClone(data)));
    } else {
      col.set(this.id, deepClone(data));
    }
  }
}

export class MockDocSnap {
  constructor(public readonly ref: MockDocRef, private readonly _data: Dict | undefined) {}
  get id(): string {
    return this.ref.id;
  }
  get exists(): boolean {
    return this._data !== undefined;
  }
  data(): Dict | undefined {
    return this._data;
  }
}

export class MockQuery {
  constructor(
    private readonly store: Store,
    private readonly collectionName: string,
    private readonly wheres: Where[],
    private readonly _limit: number | null,
  ) {}

  where(field: string, op: Where["op"], value: unknown): MockQuery {
    return new MockQuery(
      this.store,
      this.collectionName,
      [...this.wheres, { field, op, value }],
      this._limit,
    );
  }

  limit(n: number): MockQuery {
    return new MockQuery(this.store, this.collectionName, this.wheres, n);
  }

  async get(): Promise<MockQuerySnap> {
    const col = this.store.data.get(this.collectionName) ?? new Map<string, Dict>();
    const matches: MockDocSnap[] = [];
    for (const [id, raw] of col.entries()) {
      if (this.wheres.every((w) => matchesWhere(raw, w))) {
        matches.push(new MockDocSnap(new MockDocRef(this.store, this.collectionName, id), deepClone(raw)));
        if (this._limit !== null && matches.length >= this._limit) break;
      }
    }
    return { empty: matches.length === 0, docs: matches };
  }
}

function matchesWhere(raw: Dict, w: Where): boolean {
  const actual = raw[w.field];
  switch (w.op) {
    case "==":
      return actual === w.value;
    case ">=":
      return typeof actual === "number" && typeof w.value === "number" && actual >= w.value;
    case "<=":
      return typeof actual === "number" && typeof w.value === "number" && actual <= w.value;
    case ">":
      return typeof actual === "number" && typeof w.value === "number" && actual > w.value;
    case "<":
      return typeof actual === "number" && typeof w.value === "number" && actual < w.value;
  }
}

export interface MockQuerySnap {
  empty: boolean;
  docs: MockDocSnap[];
}

export class MockCollection {
  constructor(private readonly store: Store, private readonly name: string) {}

  doc(id?: string): MockDocRef {
    const docId = id ?? `auto_${++this.store.autoId}`;
    return new MockDocRef(this.store, this.name, docId);
  }

  where(field: string, op: Where["op"], value: unknown): MockQuery {
    return new MockQuery(this.store, this.name, [{ field, op, value }], null);
  }

  async add(data: Dict): Promise<MockDocRef> {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

export class MockTransaction {
  private readonly pendingWrites: Array<() => void> = [];
  constructor(private readonly store: Store) {}

  async get(ref: MockDocRef): Promise<MockDocSnap> {
    return ref.get();
  }

  set(ref: MockDocRef, data: Dict, options?: { merge?: boolean }): MockTransaction {
    this.pendingWrites.push(() => {
      void ref.set(data, options);
    });
    return this;
  }

  async _commit(): Promise<void> {
    for (const w of this.pendingWrites) w();
  }
}

export class MockFirestore {
  readonly store: Store = { data: new Map(), autoId: 0 };

  collection(name: string): MockCollection {
    return new MockCollection(this.store, name);
  }

  async runTransaction<T>(fn: (tx: MockTransaction) => Promise<T>): Promise<T> {
    const tx = new MockTransaction(this.store);
    const result = await fn(tx);
    await tx._commit();
    return result;
  }

  /** Testing helper: inspect raw stored docs. */
  _dump(collection: string): Record<string, Dict> {
    const col = this.store.data.get(collection);
    if (!col) return {};
    const out: Record<string, Dict> = {};
    for (const [id, data] of col.entries()) out[id] = deepClone(data);
    return out;
  }
}

export function makeMockDb(): MockFirestore {
  return new MockFirestore();
}
