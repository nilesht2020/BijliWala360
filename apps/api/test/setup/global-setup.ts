import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * Starts a single-node MongoDB **replica set** (transactions require one; DATABASE §1).
 * Its URI is exported via process.env, which Jest workers inherit.
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.TEST_MONGO_URI) return; // external replica set supplied (e.g. CI service container)
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await replSet.waitUntilRunning();
  (globalThis as { __MONGO_REPLSET__?: MongoMemoryReplSet }).__MONGO_REPLSET__ = replSet;
  process.env.TEST_MONGO_URI = replSet.getUri();
}
