import type {KnipConfig} from 'knip';

export default {
  entry: [
    '.ncurc.js', // cspell:disable-line
  ],
  ignoreDependencies: [],
  tags: [
    '-knipignore', // cspell:disable-line
  ],
  treatConfigHintsAsErrors: true,
} satisfies KnipConfig;
