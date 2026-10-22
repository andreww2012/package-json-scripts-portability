import {arrayIntersection} from '@andreww2012/unutils';

export type Platform = 'darwin' | 'linux' | 'win32';

export const PLATFORMS: readonly Platform[] = ['darwin', 'linux', 'win32'];

export const POSIX_PLATFORMS: readonly Platform[] = ['darwin', 'linux'];

export const MACOS_PLATFORMS: readonly Platform[] = ['darwin'];

export const LINUX_PLATFORMS: readonly Platform[] = ['linux'];

export const WINDOWS_PLATFORMS: readonly Platform[] = ['win32'];

export const NOT_LINUX_OR_WINDOWS: readonly Platform[] = ['linux', 'win32'];

export const NOT_MACOS_OR_WINDOWS: readonly Platform[] = ['darwin', 'win32'];

const PLATFORM_NAMES: Readonly<Record<Platform, string>> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
};

/**
 * Formats platforms as a list for people, e.g. "macOS, Linux, and Windows".
 * @param platforms The platforms to format
 * @returns The formatted list
 */
export const formatPlatforms = (platforms: readonly Platform[]) => {
  const names = arrayIntersection(PLATFORMS, platforms).map((platform) => PLATFORM_NAMES[platform]);

  const last = names.pop() || '';
  return names.length <= 1 ? [...names, last].join(' and ') : `${names.join(', ')}, and ${last}`;
};
