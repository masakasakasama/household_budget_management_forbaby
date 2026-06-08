export type ExpenseKind = 'fixed' | 'variable' | 'special' | 'baby' | 'medical' | 'saving';

export type Person = 'Tatsuya' | 'Partner' | 'Shared';

export type Transaction = {
  id: string;
  date: string;
  title: string;
  categoryId: string;
  amount: number;
  kind: ExpenseKind;
  payer: Person;
  memo?: string;
};

export type Category = {
  id: string;
  name: string;
  kind: ExpenseKind;
  monthlyBudget: number;
};

export type HouseholdPlan = {
  monthlyIncome: number;
  partnerIncome: number;
  savingGoal: number;
  babyReserveGoal: number;
};

export type MonthlySummary = {
  totalIncome: number;
  totalExpense: number;
  fixedExpense: number;
  variableExpense: number;
  babyExpense: number;
  medicalExpense: number;
  savingGoal: number;
  babyReserveGoal: number;
  remainingUsable: number;
  actualSaving: number;
  burnRate: number;
};
