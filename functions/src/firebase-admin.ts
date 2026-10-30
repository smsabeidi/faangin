/**
 * Lazy, test-friendly Admin SDK initialization. Each call to `getDb()` returns
 * the same Firestore handle; `_setDbForTests()` lets vitest swap in a mock
 * without the Admin SDK being initialized at all.
 */

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let testDb: Firestore | null = null;

export function _setDbForTests(db: Firestore | null): void {
  testDb = db;
}

export function getDb(): Firestore {
  if (testDb) return testDb;
  if (getApps().length === 0) {
    initializeApp();
  }
  return getFirestore();
}
