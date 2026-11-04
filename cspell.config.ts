import type {CSpellSettings} from 'cspell';

const GLOBALLY_IGNORED_WORDS: Readonly<Record<string, string[]>> = {
  names: ['andreww', 'unbash', 'utilery'],
  utilities: ['arrayify'],
  englishIshWords: ['redirections', 'subshell'],
  // Commands that the analyzer knows, and their options
  commands: ['aubx', 'bunx', 'fuser', 'nohup', 'regextype', 'xcopy'],
  // Shell variables
  shell: ['EPOCHSECONDS'],
};

export default {
  useGitignore: true,
  enableGlobDot: true,
  ignorePaths: [
    '**/.gitignore',
    '**/.git/**',
    '**/pnpm-lock.yaml',
    'patches/**',
    '.agents/guidelines.md',
  ],
  dictionaries: ['npm', 'node', 'typescript', 'fullstack', 'bash', 'powershell'],
  words: Object.values(GLOBALLY_IGNORED_WORDS).flat(),
  overrides: [],
} satisfies CSpellSettings;
