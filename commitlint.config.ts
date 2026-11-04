import {commitlintConfig} from '@andreww2012/commitlint-config';

export default commitlintConfig({
  spelling: {
    ignoreWords: ['vulns'], // cspell:disable-line
  },
  coAuthors: {
    deny: ['ai'],
  },
});
