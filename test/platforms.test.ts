import {formatPlatforms} from '../src/index.ts';

describe('formatPlatforms', () => {
  it.each([
    [['win32'], 'Windows'],
    [['darwin'], 'macOS'],
    [['linux', 'darwin'], 'macOS and Linux'],
    [['win32', 'linux'], 'Linux and Windows'],
    [['win32', 'darwin', 'linux'], 'macOS, Linux, and Windows'],
    [[], ''],
  ] as const)('formats %j as %j', (platforms, expected) => {
    expect(formatPlatforms(platforms)).toBe(expected);
  });
});
