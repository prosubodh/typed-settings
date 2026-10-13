import * as v from 'valibot';
import { settings } from '../../src/index.js';
import '../../src/node.js'; // file sources need the node entry under ESM

const schema = v.object({
  port: v.optional(v.pipe(v.unknown(), v.transform(Number), v.number()), 3000),
});

export const cfg = settings({ schema: schema as never, sources: ['.env', 'env'], prefix: 'APP_', env: {} });

console.log(cfg);
