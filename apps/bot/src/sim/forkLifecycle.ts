import type { TestClient } from 'viem';

export async function withForkSnapshot<T>(testClient: TestClient, callback: () => Promise<T>): Promise<T> {
  const snapshotId = await testClient.snapshot();
  try {
    return await callback();
  } finally {
    await testClient.revert({ id: snapshotId });
  }
}
