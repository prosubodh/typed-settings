import { type } from 'arktype';
import { settings } from '../../src/index.js';

const schema = type({ port: 'number = 3000' });

export const cfg = settings({ schema: schema as never, sources: ['.env', 'env'], prefix: 'APP_', env: {} });

console.log(cfg);
