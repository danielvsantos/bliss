/**
 * Behavioural tests for the Vercel "Ignored Build Step" scripts
 * (`apps/web/vercel-ignore.sh` and `apps/api/vercel-ignore.sh`).
 *
 * Both scripts are plain bash and run outside the app, but they gate every
 * preview/production deploy, so their exit-code contract is worth locking down:
 *
 *   exit 1 = build,  exit 0 = skip
 *
 * The regression that motivated these tests: the scripts used `git diff HEAD^`,
 * but Vercel checks out a shallow clone where `HEAD^` often does not exist. git
 * then errored, the old `if [ $? -eq 1 ]` fell through to the "no changes"
 * branch, and the deploy was silently skipped. The scripts must now FAIL OPEN
 * (build) whenever the diff base cannot be resolved.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_SCRIPT = path.resolve(here, '../../vercel-ignore.sh');
const API_SCRIPT = path.resolve(here, '../../../api/vercel-ignore.sh');

/** process.env minus any VERCEL_* keys, so each test sets exactly what it needs. */
function baseEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('VERCEL_')) e[k] = v;
  }
  return e;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

function runIgnore(
  script: string,
  cwd: string,
  env: Record<string, string>,
): { code: number; out: string } {
  const r = spawnSync('bash', [script], { cwd, encoding: 'utf8', env });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe('vercel-ignore.sh', () => {
  let repo: string;
  let sha1: string; // c1: package.json + README + apps/web/a.txt
  let sha2: string; // c2: README only
  let sha3: string; // c3: apps/web/a.txt
  let sha4: string; // c4: packages/shared/s.txt

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-ignore-'));
    fs.mkdirSync(path.join(repo, 'apps/web'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'apps/api'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'packages/shared'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'prisma'), { recursive: true });

    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);

    const w = (p: string, c: string) => fs.writeFileSync(path.join(repo, p), c);

    w('package.json', '{}\n');
    w('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    w('README.md', '1\n');
    w('apps/web/a.txt', '1\n');
    w('apps/api/a.txt', '1\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'c1']);
    sha1 = git(repo, ['rev-parse', 'HEAD']);

    w('README.md', '2\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'c2']);
    sha2 = git(repo, ['rev-parse', 'HEAD']);

    w('apps/web/a.txt', '2\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'c3']);
    sha3 = git(repo, ['rev-parse', 'HEAD']);

    w('packages/shared/s.txt', '1\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'c4']);
    sha4 = git(repo, ['rev-parse', 'HEAD']);
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('always builds on the main branch (exit 1)', () => {
    const { code } = runIgnore(WEB_SCRIPT, repo, {
      ...baseEnv(),
      VERCEL_GIT_COMMIT_REF: 'main',
    });
    expect(code).toBe(1);
  });

  it('fails open (builds) when there is no resolvable diff base — the shallow-clone case', () => {
    // Detach onto the very first commit: HEAD^ does not exist and there is no
    // remote to deepen from. Old script errored → skipped; new one must build.
    git(repo, ['checkout', '-q', sha1]);
    const { code, out } = runIgnore(WEB_SCRIPT, repo, {
      ...baseEnv(),
      VERCEL_GIT_COMMIT_REF: 'feature/x',
      // VERCEL_GIT_PREVIOUS_SHA intentionally unset
    });
    expect(code, out).toBe(1);
    expect(out).toMatch(/no usable diff base/i);
  });

  it('fails open (builds) when VERCEL_GIT_PREVIOUS_SHA points at a missing commit', () => {
    git(repo, ['checkout', '-q', sha3]);
    const { code } = runIgnore(WEB_SCRIPT, repo, {
      ...baseEnv(),
      VERCEL_GIT_COMMIT_REF: 'feature/x',
      VERCEL_GIT_PREVIOUS_SHA: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    expect(code).toBe(1);
  });

  it('skips (exit 0) when the diff since the base touches no relevant path', () => {
    git(repo, ['checkout', '-q', sha2]); // c1 -> c2 changed only README.md
    const { code, out } = runIgnore(WEB_SCRIPT, repo, {
      ...baseEnv(),
      VERCEL_GIT_COMMIT_REF: 'feature/x',
      VERCEL_GIT_PREVIOUS_SHA: sha1,
    });
    expect(code, out).toBe(0);
    expect(out).toMatch(/no relevant changes/i);
  });

  it('builds (exit 1) when apps/web changed since the base', () => {
    git(repo, ['checkout', '-q', sha3]); // c2 -> c3 changed apps/web/a.txt
    const { code } = runIgnore(WEB_SCRIPT, repo, {
      ...baseEnv(),
      VERCEL_GIT_COMMIT_REF: 'feature/x',
      VERCEL_GIT_PREVIOUS_SHA: sha2,
    });
    expect(code).toBe(1);
  });

  it('both scripts build (exit 1) when packages/shared changed since the base', () => {
    git(repo, ['checkout', '-q', sha4]); // c3 -> c4 changed packages/shared/s.txt
    const env = {
      ...baseEnv(),
      VERCEL_GIT_COMMIT_REF: 'feature/x',
      VERCEL_GIT_PREVIOUS_SHA: sha3,
    };
    expect(runIgnore(WEB_SCRIPT, repo, env).code).toBe(1);
    expect(runIgnore(API_SCRIPT, repo, env).code).toBe(1);
  });

  it('api script skips (exit 0) for a web-only change', () => {
    git(repo, ['checkout', '-q', sha3]); // c2 -> c3 changed apps/web only
    const { code, out } = runIgnore(API_SCRIPT, repo, {
      ...baseEnv(),
      VERCEL_GIT_COMMIT_REF: 'feature/x',
      VERCEL_GIT_PREVIOUS_SHA: sha2,
    });
    expect(code, out).toBe(0);
  });
});
