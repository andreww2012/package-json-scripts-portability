import {type Platform, formatPlatforms} from '../src/index.ts';

describe('formatPlatforms', () => {
  it.each<[Platform[], string]>([
    [['win32'], 'Windows'],
    [['darwin'], 'macOS'],
    [['linux', 'darwin'], 'macOS and Linux'],
    [['win32', 'linux'], 'Linux and Windows'],
    [['win32', 'darwin', 'linux'], 'macOS, Linux, and Windows'],
    [[], ''],
  ])('formats %j as %j', (platforms, expected) => {
    expect(formatPlatforms(platforms)).toBe(expected);
  });
});
