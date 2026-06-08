import type { Category, HouseholdPlan, MonthlySummary, Transaction } from './types';

export const yen = (value: number) =>
  new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY', maximumFractionDigits: 0 }).format(value);

export const shortYen = (value: number) => `${Math.round(value / 10000)}万円`;

export const getCategory = (categories: Category[], categoryId: string) =>
  categories.find((category) => category.id === categoryId);

export const sumByKind = (transactions: Transaction[], kind: Transaction['kind']) =>
  transactions.filter((tx) => tx.kind === kind).reduce((sum, tx) => sum + tx.amount, 0);

export const calculateSummary = (
  plan: HouseholdPlan,
  transactions: Transaction[],
): MonthlySummary => {
  const totalIncome = plan.monthlyIncome + plan.partnerIncome;
  const totalExpense = transactions.reduce((sum, tx) => sum + tx.amount, 0);
  const fixedExpense = sumByKind(transactions, 'fixed');
  const variableExpense = sumByKind(transactions, 'variable') + sumByKind(transactions, 'special');
  const babyExpense = sumByKind(transactions, 'baby');
  const medicalExpense = sumByKind(transactions, 'medical');
  const actualSaving = totalIncome - totalExpense;
  const remainingUsable = totalIncome - totalExpense - plan.savingGoal - plan.babyReserveGoal;
  const burnRate = totalIncome === 0 ? 0 : Math.round((totalExpense / totalIncome) * 100);

  return {
    totalIncome,
    totalExpense,
    fixedExpense,
    variableExpense,
    babyExpense,
    medicalExpense,
    savingGoal: plan.savingGoal,
    babyReserveGoal: plan.babyReserveGoal,
    remainingUsable,
    actualSaving,
    burnRate,
  };
};

export const aggregateByCategory = (transactions: Transaction[], categories: Category[]) =>
  categories
    .map((category) => {
      const actual = transactions
        .filter((tx) => tx.categoryId === category.id)
        .reduce((sum, tx) => sum + tx.amount, 0);
      return {
        ...category,
        actual,
        remaining: category.monthlyBudget - actual,
        usageRate: category.monthlyBudget === 0 ? 0 : Math.round((actual / category.monthlyBudget) * 100),
      };
    })
    .filter((category) => category.monthlyBudget > 0 || category.actual > 0);

export const babyProjection = (plan: HouseholdPlan, monthlyBabyCost: number, months = 12) => {
  const result = [];
  let reserve = plan.babyReserveGoal * 3;

  for (let month = 1; month <= months; month += 1) {
    reserve += plan.babyReserveGoal - monthlyBabyCost;
    result.push({
      month: `${month}ヶ月後`,
      reserve: Math.max(reserve, 0),
    });
  }

  return result;
};
