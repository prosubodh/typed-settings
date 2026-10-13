import { type } from 'arktype';
import { settings } from '../../src/index.js';
import '../../src/node.js'; // file sources need the node entry under ESM

const schema = type({ port: 'number = 3000' });

export const cfg = settings({ schema: schema as never, sources: ['.env', 'env'], prefix: 'APP_', env: {} });

console.log(cfg);
