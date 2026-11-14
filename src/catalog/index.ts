import type { CatalogItem, Category } from './schema';
import { inputs } from './inputs';
import { secrets } from './secrets';
import { local } from './local';
import { remote } from './remote';

export * from './schema';
export { inputs };

export const categories: { id: Category; title: string; blurb: string }[] = [
  { id: 'secrets', title: 'Secrets and credentials', blurb: 'Once read, a key cannot be un-read.' },
  { id: 'local', title: 'Destroying local work', blurb: 'Deleted files and discarded changes cannot be recovered.' },
  { id: 'remote', title: 'Things that leave the machine', blurb: 'A push, a publish or a sent message cannot be recalled.' },
];

export const catalog: CatalogItem[] = [...secrets, ...local, ...remote];
