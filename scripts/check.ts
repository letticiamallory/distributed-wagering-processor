// `bun run check`: as verificações estáticas em sequência, parando na primeira que falhar. Um
// script em vez de `a && b && c` no package.json, para rodar igual em bash, no PowerShell 5.1 (que
// não tem &&) e no CI.
const CHECKS = ['typecheck', 'lint', 'format:check', 'check:money'];

for (const name of CHECKS) {
  console.log(`\n> bun run ${name}`);
  const result = Bun.spawnSync([process.execPath, 'run', name], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (result.exitCode !== 0) {
    console.error(`\ncheck: "${name}" failed (exit ${result.exitCode})`);
    process.exit(result.exitCode ?? 1);
  }
}
console.log(`\ncheck: OK (${CHECKS.join(', ')})`);
