import {type Runner, formatRunners, getRunner} from '../src/index.ts';

describe('getRunner', () => {
  it.each<[string, string | undefined, Runner | undefined]>([
    ['npm', '11.0.0', 'npm'],
    ['pnpm', '11.0.0', 'pnpm'],
    // pnpm v10 and older set `HOME`
    ['pnpm', '10.0.0', 'pnpm-10'],
    ['pnpm', '^9.15.0', 'pnpm-10'],
    // Possibly pnpm v11+
    ['pnpm', '>=10', 'pnpm'],
    ['pnpm', undefined, 'pnpm'],
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
    ['pnpm-10', undefined, undefined],
    ['yarn-classic', undefined, undefined],
  ])('gets the runner for %s %s', (name, version, expected) => {
    expect(getRunner(name, version)).toBe(expected);
  });
});

describe('formatRunners', () => {
  it.each<[Runner[], string]>([
    [['npm'], 'npm'],
    [['yarn-classic', 'pnpm'], 'pnpm and Yarn v1'],
    [['pnpm-10', 'pnpm'], 'pnpm and pnpm v10'],
    [['node', 'upm', 'aube'], 'aube, `node --run`, and upm'],
    [[], ''],
  ])('formats %j as %j', (runners, expected) => {
    expect(formatRunners(runners)).toBe(expected);
  });
});
