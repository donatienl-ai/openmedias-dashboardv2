function parseMonthlyObjective(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) {
    throw new RangeError('Saisis un montant entier en euros, supérieur ou égal à 0.');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new RangeError('Saisis un montant entier en euros, supérieur ou égal à 0.');
  return number;
}
module.exports = { parseMonthlyObjective };
