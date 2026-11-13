import {parse} from 'unbash';
import {analyzeScript} from '../src/index.ts';

vi.mock(import('unbash'), {spy: true});

describe('script parsing', () => {
  it('parses a script and the scripts nested in it once for all runners', () => {
    const issues = analyzeScript('sh -c "rm -rf dist"', {runner: ['npm', 'pnpm', 'yarn']});

    expect(issues.length).toBeGreaterThan(0);
    expect(parse).toHaveBeenCalledTimes(2);
  });
});
