import {type Runner, getRunner} from '../src/index.ts';

describe('getRunner', () => {
  it.each<[string, string | undefined, Runner | undefined]>([
    ['npm', '11.0.0', 'npm'],
    ['pnpm', '10.0.0', 'pnpm'],
    ['aube', undefined, 'aube'],
    ['upm', '0.1.0', 'upm'],
    ['yarn', '1.22.22', 'yarn-classic'],
    ['yarn', '^1.22.0', 'yarn-classic'],
    ['yarn', '4.5.0', 'yarn'],
    ['yarn', '>=2', 'yarn'],
    // Yarn v1 and v2+ run scripts differently
    ['yarn', undefined, undefined],
    ['yarn', 'latest', undefined],
    ['bun', '1.2.0', undefined],
    ['deno', undefined, undefined],
    // Not package managers
    ['node', '24.0.0', undefined],
    ['yarn-classic', undefined, undefined],
  ])('gets the runner for %s %s', (name, version, expected) => {
    expect(getRunner(name, version)).toBe(expected);
  });
});
