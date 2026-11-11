import {defineConfig} from 'tsdown';

export default defineConfig({
  entry: 'src/index.ts',
  dts: true,
  exports: true,
  unbundle: true,
  publint: {strict: true},
  attw: {level: 'error'},
  deps: {
    onlyBundle: ['utilery'],
  },
});
