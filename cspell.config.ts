import type {CSpellSettings} from 'cspell';

const GLOBALLY_IGNORED_WORDS: Readonly<Record<string, string[]>> = {
  names: ['andreww', 'unbash', 'unutils'],
  englishIshWords: ['redirections', 'subshell', 'unmappable'],
  // OS commands that the analyzer knows, and their options
  commands: ['bunx', 'fuser', 'nohup', 'regextype', 'xcopy'],
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
