// Minimal no-framework test harness. Register cases with test(), assert with
// eq()/ok(), then call run() to print results and exit non-zero on any failure.

const cases = [];

export function test(name, fn) {
  cases.push({ name, fn });
}

export function ok(cond, msg = "expected truthy") {
  if (!cond) throw new Error(msg);
}

export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(msg ? `${msg}: ${a} !== ${e}` : `${a} !== ${e}`);
  }
}

export async function run() {
  let passed = 0;
  const failures = [];
  for (const { name, fn } of cases) {
    try {
      await fn();
      passed++;
      console.log(`  ok   ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  FAIL ${name}`);
      console.log(`       ${err.message}`);
    }
  }
  console.log(`\n${passed}/${cases.length} passed`);
  if (failures.length) process.exit(1);
}
