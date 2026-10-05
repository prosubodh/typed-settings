import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/node.ts',
    'src/cli/main.ts',
    'src/framework/next.ts',
    'src/framework/vite.ts',
    'src/adapters/zod.ts',
    'src/adapters/yup.ts',
    'src/adapters/joi.ts',
    'src/adapters/superstruct.ts',
    'src/formats/env.ts',
    'src/formats/json.ts',
    'src/formats/yaml.ts',
    'src/formats/toml.ts',
    'src/vault/hashicorp.ts',
    'src/vault/aws.ts',
    'src/vault/http.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  minify: false,
  treeshake: true,
  sideEffects: false,
});
