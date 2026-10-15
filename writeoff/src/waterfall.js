'use strict';

// ----------------------------------------------------------------------------
// Водопад: раскладывает сумму к отпису по корзинам в заданном порядке.
//
// Чистая функция на целых haléřích. Ни сети, ни конфига, ни времени —
// поэтому её поведение полностью покрывается тестами, а именно она решает,
// сколько денег списать с каждой корзины.
//
// Инвариант, который держим: allocation[b] <= buckets[b] для каждой корзины,
// и sum(allocation) <= amount. Апи отдаёт invalidAmount, если компонент
// больше остатка — до этого доводить нельзя.
// ----------------------------------------------------------------------------

function allocate({ buckets, order, amount }) {
  if (!Number.isInteger(amount)) throw new TypeError(`allocate: amount не целое: ${amount}`);
  if (amount < 0) throw new RangeError(`allocate: amount отрицательный: ${amount}`);
  if (!Array.isArray(order)) throw new TypeError('allocate: order не массив');

  const allocation = {};
  const steps = [];
  let left = amount;

  for (const bucket of order) {
    const available = buckets[bucket] ?? 0;
    if (!Number.isInteger(available)) {
      throw new TypeError(`allocate: остаток корзины ${bucket} не целый: ${available}`);
    }
    if (available < 0) {
      throw new RangeError(`allocate: отрицательный остаток корзины ${bucket}: ${available}`);
    }
    if (left === 0 || available === 0) {
      steps.push({ bucket, available, taken: 0, leftAfter: left });
      continue;
    }

    const taken = Math.min(available, left);
    allocation[bucket] = taken;
    left -= taken;
    steps.push({ bucket, available, taken, leftAfter: left, partial: taken < available });
  }

  return {
    allocation,                              // только непустые корзины
    allocated: amount - left,
    shortfall: left,                         // > 0 => корзин не хватило на target
    steps,                                   // полный след для отчёта и аудита
    capacity: order.reduce((acc, b) => acc + (buckets[b] ?? 0), 0),
  };
}

module.exports = { allocate };
