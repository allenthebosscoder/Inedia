import { genericAdapter } from './generic-adapter';
import { Adapter } from './types';

export function pickAdapter(hostname: string, adapters: Adapter[]): Adapter {
  const match = adapters.find((adapter) => adapter.matchesHostname(hostname));
  return match ?? genericAdapter;
}
