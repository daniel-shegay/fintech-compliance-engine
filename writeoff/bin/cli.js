#!/usr/bin/env node
'use strict';

// ----------------------------------------------------------------------------
// CLI модуля отписа. Интерфейса нет — это и есть интерфейс.
//
//   probe    --customer 189463 [--credit 1026701]
//   preview  --customer 189463 --credit 1026701 --target 25000
//   apply    --customer 189463 --credit 1026701 --target 25000 [--live]
//   history  --key <idempotencyKey>
//
// apply без --live ничего не отправляет и печатает готовое тело запроса.
// ----------------------------------------------------------------------------

const {
  config, assertUsable, fetchCreditRows, buildBalance, selectCreditRow, listDebtors,
  buildPlan, applyPlan, audit, formatPlan, formatApply, formatProbe, money,
} = require('../src');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new Error(`неожиданный аргумент: ${token}`);
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return { command, flags };
}

function required(flags, name) {
  const value = flags[name];
  if (value === undefined || value === true || value === '') {
    throw new Error(`--${name} обязателен`);
  }
  return value;
}

const USAGE = `
fintech-writeoff — отпис долга по иерархии корзин

  probe    --customer <id> [--credit <id>]              показать остатки и сверку с debt
  preview  --customer <id> --credit <id> --target <Kč>  раскладка отписа, ничего не отправляет
  apply    --customer <id> --credit <id> --target <Kč>  провести отпис
             [--live]        реально отправить (без флага — dry-run)
             [--force]       снять снимаемые гарды / повторить проводку
             [--notes "..."] познамка в отпис
             [--no-verify]   не перечитывать баланс после проводки
  history  --key <ключ>                                 записи аудита по ключу

Окружение:
  CREDITGO_API_KEY            ключ (обязателен)
  CREDITGO_BASE_URL           ${config.BASE_URL}
  CREDITGO_EXPORT_ID          ${config.EXPORT_ID}
  CREDITGO_AUTH_MODE          ${config.AUTH_MODE}   (header|query)
  CREDITGO_WRITEOFF_TRANSPORT ${config.WRITEOFF_TRANSPORT}     (body|query)
  CREDITGO_ACTOR              имя оператора для познамок и аудита
  CREDITGO_AUDIT_DIR          ${config.AUDIT_DIR}
  CREDITGO_DEBT_TOLERANCE     ${config.DEBT_TOLERANCE_MINOR}        допуск сверки, haléře
`.trim();

async function cmdProbe(flags) {
  const customerId = required(flags, 'customer');
  const creditId = flags.credit && flags.credit !== true ? flags.credit : null;

  const { rows } = await fetchCreditRows({ customerId, creditId });

  if (!creditId) {
    const debtors = listDebtors(rows);
    console.log(`Клиент ${customerId}: строк в экспорте ${rows.length}, с долгом ${debtors.length}`);
    for (const entry of debtors) {
      console.log(`  кредит ${entry.creditId}  долг ${money.fromMinor(entry.debt)}`);
    }
    if (debtors.length) console.log('\nЗапустите probe с --credit <id> для разбора по корзинам.');
    return;
  }

  console.log(formatProbe(buildBalance(selectCreditRow(rows, creditId))));
}

async function cmdPreview(flags) {
  const plan = await buildPlan({
    customerId: required(flags, 'customer'),
    creditId: required(flags, 'credit'),
    target: required(flags, 'target'),
    notes: flags.notes && flags.notes !== true ? flags.notes : '',
  });
  console.log(formatPlan(plan));
  return plan;
}

async function cmdApply(flags) {
  const plan = await cmdPreview(flags);
  console.log(`\n${'='.repeat(70)}\n`);

  const live = flags.live === true;
  if (!live) {
    console.log('Режим dry-run (нет --live). Запрос отправлен НЕ будет.\n');
  }

  const result = await applyPlan(plan, {
    live,
    force: flags.force === true,
    notes: flags.notes && flags.notes !== true ? flags.notes : plan.notes,
    skipVerify: flags['no-verify'] === true,
  });

  console.log(formatApply(result));
  if (['dangling_intent', 'applied_unverified'].includes(result.status)) process.exitCode = 2;
}

async function cmdHistory(flags) {
  const entries = await audit.history(required(flags, 'key'));
  if (!entries.length) {
    console.log('Записей по этому ключу нет.');
    return;
  }
  for (const entry of entries) {
    console.log(`${entry.ts}  ${entry.event}  ${JSON.stringify(entry)}`);
  }
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (!command || flags.help || command === 'help') {
    console.log(USAGE);
    return;
  }

  const needsKey = ['probe', 'preview', 'apply'].includes(command);
  if (needsKey) assertUsable();

  switch (command) {
    case 'probe': return cmdProbe(flags);
    case 'preview': return cmdPreview(flags).then(() => undefined);
    case 'apply': return cmdApply(flags);
    case 'history': return cmdHistory(flags);
    default:
      throw new Error(`неизвестная команда «${command}». ${'\n'}${USAGE}`);
  }
}

main().catch((err) => {
  console.error(`\nОшибка: ${err.message}`);
  if (process.env.CREDITGO_DEBUG) console.error(err);
  process.exitCode = 1;
});
