import type { Category, HouseholdPlan, Transaction } from './types';

export const categories: Category[] = [
  { id: 'rent', name: '住居', kind: 'fixed', monthlyBudget: 165000 },
  { id: 'utility', name: '光熱費', kind: 'fixed', monthlyBudget: 25000 },
  { id: 'phone', name: '通信', kind: 'fixed', monthlyBudget: 12000 },
  { id: 'insurance', name: '保険', kind: 'fixed', monthlyBudget: 10000 },
  { id: 'food', name: '食費', kind: 'variable', monthlyBudget: 70000 },
  { id: 'dining', name: '外食', kind: 'variable', monthlyBudget: 50000 },
  { id: 'transport', name: '交通', kind: 'variable', monthlyBudget: 25000 },
  { id: 'travel', name: '旅行', kind: 'special', monthlyBudget: 50000 },
  { id: 'gift', name: 'プレゼント', kind: 'special', monthlyBudget: 30000 },
  { id: 'baby-goods', name: 'ベビー用品', kind: 'baby', monthlyBudget: 40000 },
  { id: 'birth-prep', name: '出産準備', kind: 'baby', monthlyBudget: 60000 },
  { id: 'medical', name: '医療', kind: 'medical', monthlyBudget: 20000 },
  { id: 'nursery', name: '保育園', kind: 'baby', monthlyBudget: 50000 },
  { id: 'saving', name: '貯金・投資', kind: 'saving', monthlyBudget: 180000 },
];

export const defaultPlan: HouseholdPlan = {
  monthlyIncome: 600000,
  partnerIncome: 250000,
  savingGoal: 180000,
  babyReserveGoal: 80000,
};

export const initialTransactions: Transaction[] = [
  { id: 'tx-1', date: '2026-06-01', title: '家賃', categoryId: 'rent', amount: 165000, kind: 'fixed', payer: 'Shared' },
  { id: 'tx-2', date: '2026-06-02', title: 'povo・通信費', categoryId: 'phone', amount: 3500, kind: 'fixed', payer: 'Tatsuya' },
  { id: 'tx-3', date: '2026-06-03', title: 'スーパー', categoryId: 'food', amount: 6200, kind: 'variable', payer: 'Shared' },
  { id: 'tx-4', date: '2026-06-04', title: '外食', categoryId: 'dining', amount: 8400, kind: 'variable', payer: 'Shared' },
  { id: 'tx-5', date: '2026-06-05', title: 'ベビー用品下見', categoryId: 'baby-goods', amount: 12800, kind: 'baby', payer: 'Shared' },
  { id: 'tx-6', date: '2026-06-06', title: '病院', categoryId: 'medical', amount: 4500, kind: 'medical', payer: 'Partner' },
  { id: 'tx-7', date: '2026-06-07', title: '新潟旅行準備', categoryId: 'travel', amount: 22000, kind: 'special', payer: 'Tatsuya' },
];
