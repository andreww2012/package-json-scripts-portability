import {eslintConfig} from 'eslint-config-un';
import {forbidImportingFromUtilityLibraries} from 'eslint-config-un/snippets';
import oxfmtConfig from './oxfmt.config.ts';

export default eslintConfig({
  ignores: ['.agents/guidelines.md', 'CHANGELOG.md'],
  mode: 'lib',
  defaultConfigsStatus: 'misc-enabled',
  configs: {
    eslintComments: {
      requireDescriptions: true,
    },
    format: {
      files: [],
      configFencedCodeBlocks: {
        formatter: [
          'oxfmt',
          {
            bracketSpacing: oxfmtConfig.bracketSpacing,
            printWidth: oxfmtConfig.printWidth,
            singleQuote: oxfmtConfig.singleQuote,
          },
        ],
      },
    },
    import: {
      requireModuleExtensions: true,
      extraneousDependenciesCheck: {
        // Bundled
        whitelist: ['utilery'],
      },
    },
    js: {
      overrides: {
        // Scripts and messages about them contain variable expansions like `${VAR}`
        'no-template-curly-in-string': 0,
      },
    },
    markdown: {
      configSentencesPerLine: true,
    },
    nodeDependencies: {
      enforceAbsoluteVersion: true,
      overrides: {
        'node-dependencies/compat-engines': (severity, options) => ({
          severity,
          options: [{...options?.[0], devDependencies: false}],
        }),
      },
    },
    ts: {
      overrides: {
        'ts/no-restricted-types': [
          2,
          {
            types: {
              Omit: 'Use `OmitStrict` from `src/utils.ts` instead',
            },
          },
        ],
      },
    },
    un: {
      overrides: {
        'un/no-type-assertion': 2,
        'un/prefer-array-for-each': 2,
        'un/prefer-logical-or': 2,
      },
    },
    unicorn: {
      overrides: {
        // Conflicts with `ts/consistent-return`, which requires `return undefined` in functions
        // that return a value elsewhere
        'unicorn/no-useless-undefined': 0,
      },
    },
    vitest: {
      vitestGlobalsImporting: 'disallow',
    },
  },
  extraConfigs: [
    {
      name: 'forbid-utility-package-imports',
      ignores: ['src/utils.ts'],
      rules: {
        'no-restricted-imports': [
          2,
          {
            patterns: [
              forbidImportingFromUtilityLibraries({
                packageNames: {
                  utilery: true,
                },
                message: 'Import utilities from `src/utils.ts` instead',
              }),
            ],
          },
        ],
      },
    },
  ],
});
