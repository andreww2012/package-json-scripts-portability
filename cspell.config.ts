import {cspellConfig} from '@andreww2012/cspell-config';

export default cspellConfig({
  // eslint-disable-next-line node/no-unsupported-features/node-builtins -- Only used in development
  cwd: import.meta.dirname,
  ignorePaths: ['.agents/guidelines.md', '.all-contributorsrc'],
  dictionaries: ['bash', 'powershell'],
  words: {
    names: ['andreww', 'unbash', 'utilery'],
    utilities: ['arrayify'],
    englishIshWords: ['redirections', 'subshell'],
    // Commands that the analyzer knows, and their options
    commands: ['aubx', 'bunx', 'fuser', 'nohup', 'regextype', 'xcopy'],
    // Shell variables
    shell: ['EPOCHSECONDS'],
  },
});
