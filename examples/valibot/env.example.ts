import * as v from 'valibot';
import { settings } from '../../src/index.js';

const schema = v.object({
  port: v.optional(v.pipe(v.unknown(), v.transform(Number)), 3000),
});

export const cfg = settings({ schema: schema as never, sources: ['.env', 'env'], prefix: 'APP_', env: {} });

console.log(cfg);
