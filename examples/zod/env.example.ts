import { z } from 'zod';
import { settings } from '../../src/index.js';
import '../../src/node.js'; // file sources need the node entry under ESM

export const cfg = settings({
  schema: z.object({
    port: z.coerce.number().default(3000),
    db: z.object({ host: z.string().default('localhost') }),
  }),
  sources: ['.env', 'env'],
  prefix: 'APP_',
});

console.log(cfg);
