import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Baby, CircleDollarSign, Home, PiggyBank, Plus, Smartphone, TrendingDown, TrendingUp, WalletCards } from 'lucide-react';
import { categories, defaultPlan, initialTransactions } from './data';
import { aggregateByCategory, babyProjection, calculateSummary, getCategory, shortYen, yen } from './calculate';
import type { HouseholdPlan, Person, Transaction } from './types';
import './styles.css';

const storageKey = 'baby-budget-v1';

const loadTransactions = (): Transaction[] => {
  const saved = window.localStorage.getItem(storageKey);
  if (!saved) return initialTransactions;
  try {
    return JSON.parse(saved) as Transaction[];
  } catch {
    return initialTransactions;
  }
};

const createId = () => `tx-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function App() {
  const [plan, setPlan] = useState<HouseholdPlan>(defaultPlan);
  const [transactions, setTransactions] = useState<Transaction[]>(loadTransactions);
  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    title: '',
    amount: '',
    categoryId: 'food',
    payer: 'Shared' as Person,
    memo: '',
  });

  const summary = useMemo(() => calculateSummary(plan, transactions), [plan, transactions]);
  const categoryRows = useMemo(() => aggregateByCategory(transactions, categories), [transactions]);
  const projection = useMemo(() => babyProjection(plan, 55000, 12), [plan]);
  const selectedCategory = getCategory(categories, form.categoryId) ?? categories[0];

  const saveTransactions = (next: Transaction[]) => {
    setTransactions(next);
    window.localStorage.setItem(storageKey, JSON.stringify(next));
  };

  const addTransaction = () => {
    const amount = Number(form.amount);
    if (!form.title.trim() || !amount || amount < 0) return;

    const next: Transaction[] = [
      {
        id: createId(),
        date: form.date,
        title: form.title.trim(),
        amount,
        categoryId: form.categoryId,
        kind: selectedCategory.kind,
        payer: form.payer,
        memo: form.memo.trim(),
      },
      ...transactions,
    ];

    saveTransactions(next);
    setForm((current) => ({ ...current, title: '', amount: '', memo: '' }));
  };

  const removeTransaction = (id: string) => {
    saveTransactions(transactions.filter((tx) => tx.id !== id));
  };

  const resetDemo = () => {
    saveTransactions(initialTransactions);
  };

  const pieData = [
    { name: '固定費', value: summary.fixedExpense },
    { name: '変動・特別費', value: summary.variableExpense },
    { name: 'ベビー', value: summary.babyExpense },
    { name: '医療', value: summary.medicalExpense },
  ].filter((item) => item.value > 0);

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Household Budget for Baby</p>
          <h1>出産・育児を見据えた家計管理</h1>
          <p className="hero-copy">今月あといくら使えるか、ベビー準備費が足りるかをスマホで確認できます。</p>
        </div>
        <div className="phone-badge"><Smartphone size={18} /> iPhone対応</div>
      </header>

      <section className="summary-grid">
        <SummaryCard icon={<CircleDollarSign />} label="今月の可処分残額" value={yen(summary.remainingUsable)} tone={summary.remainingUsable >= 0 ? 'good' : 'bad'} sub="収入から支出、貯金目標、ベビー準備金を控除" />
        <SummaryCard icon={<WalletCards />} label="今月の支出" value={yen(summary.totalExpense)} tone="neutral" sub={`消化率 ${summary.burnRate}%`} />
        <SummaryCard icon={<PiggyBank />} label="貯金見込み" value={yen(summary.actualSaving)} tone={summary.actualSaving >= plan.savingGoal ? 'good' : 'warn'} sub={`目標 ${yen(plan.savingGoal)}`} />
        <SummaryCard icon={<Baby />} label="ベビー関連支出" value={yen(summary.babyExpense)} tone="baby" sub={`準備金目標 ${yen(plan.babyReserveGoal)}`} />
      </section>

      <main className="content-grid">
        <section className="panel input-panel">
          <div className="panel-title-row">
            <div>
              <p className="eyebrow">Input</p>
              <h2>支出を追加</h2>
            </div>
            <Plus size={22} />
          </div>

          <div className="form-grid">
            <label>
              日付
              <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </label>
            <label>
              金額
              <input inputMode="numeric" placeholder="例 3500" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value.replace(/[^0-9]/g, '') })} />
            </label>
            <label className="wide">
              内容
              <input placeholder="スーパー、病院、ベビー用品など" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </label>
            <label>
              カテゴリ
              <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
              </select>
            </label>
            <label>
              支払者
              <select value={form.payer} onChange={(e) => setForm({ ...form, payer: e.target.value as Person })}>
                <option value="Shared">共通</option>
                <option value="Tatsuya">Tatsuya</option>
                <option value="Partner">Partner</option>
              </select>
            </label>
            <label className="wide">
              メモ
              <input placeholder="任意" value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} />
            </label>
          </div>

          <button className="primary-button" onClick={addTransaction}>追加する</button>
        </section>

        <section className="panel">
          <p className="eyebrow">Plan</p>
          <h2>月次計画</h2>
          <div className="plan-grid">
            <NumberInput label="本人手取り" value={plan.monthlyIncome} onChange={(value) => setPlan({ ...plan, monthlyIncome: value })} />
            <NumberInput label="パートナー手取り" value={plan.partnerIncome} onChange={(value) => setPlan({ ...plan, partnerIncome: value })} />
            <NumberInput label="貯金目標" value={plan.savingGoal} onChange={(value) => setPlan({ ...plan, savingGoal: value })} />
            <NumberInput label="ベビー準備金" value={plan.babyReserveGoal} onChange={(value) => setPlan({ ...plan, babyReserveGoal: value })} />
          </div>
        </section>

        <section className="panel chart-panel">
          <p className="eyebrow">Breakdown</p>
          <h2>支出内訳</h2>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={58} outerRadius={88} paddingAngle={3}>
                  {pieData.map((_, index) => <Cell key={index} />)}
                </Pie>
                <Tooltip formatter={(value) => yen(Number(value))} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="panel chart-panel">
          <p className="eyebrow">Baby Reserve</p>
          <h2>ベビー準備金予測</h2>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={projection}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={shortYen} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value) => yen(Number(value))} />
                <Area type="monotone" dataKey="reserve" strokeWidth={3} fillOpacity={0.2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="panel wide-panel">
          <p className="eyebrow">Budget</p>
          <h2>カテゴリ別 予算対実績</h2>
          <div className="bar-box">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={categoryRows.slice(0, 10)}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={shortYen} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(value) => yen(Number(value))} />
                <Bar dataKey="monthlyBudget" name="予算" radius={[8, 8, 0, 0]} />
                <Bar dataKey="actual" name="実績" radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="category-list">
            {categoryRows.map((row) => (
              <div key={row.id} className="category-row">
                <div>
                  <strong>{row.name}</strong>
                  <span>{yen(row.actual)} / {yen(row.monthlyBudget)}</span>
                </div>
                <div className="progress"><i style={{ width: `${Math.min(row.usageRate, 100)}%` }} /></div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel wide-panel">
          <div className="panel-title-row">
            <div>
              <p className="eyebrow">Transactions</p>
              <h2>最近の支出</h2>
            </div>
            <button className="ghost-button" onClick={resetDemo}>初期データに戻す</button>
          </div>
          <div className="transaction-list">
            {transactions.map((tx) => {
              const category = getCategory(categories, tx.categoryId);
              return (
                <article key={tx.id} className="transaction-card">
                  <div>
                    <time>{tx.date}</time>
                    <h3>{tx.title}</h3>
                    <p>{category?.name ?? '未分類'} ・ {tx.payer}{tx.memo ? ` ・ ${tx.memo}` : ''}</p>
                  </div>
                  <div className="transaction-amount">
                    <strong>{yen(tx.amount)}</strong>
                    <button onClick={() => removeTransaction(tx.id)}>削除</button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </main>

      <nav className="bottom-nav" aria-label="iPhone bottom navigation">
        <a href="#root"><Home size={19} />ホーム</a>
        <a href="#root"><TrendingUp size={19} />分析</a>
        <a href="#root"><TrendingDown size={19} />支出</a>
        <a href="#root"><Baby size={19} />ベビー</a>
      </nav>
    </div>
  );
}

function SummaryCard({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub: string; tone: 'good' | 'bad' | 'warn' | 'neutral' | 'baby' }) {
  return (
    <article className={`summary-card ${tone}`}>
      <div className="summary-icon">{icon}</div>
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{sub}</span>
    </article>
  );
}

function NumberInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label>
      {label}
      <input inputMode="numeric" value={String(value)} onChange={(event) => onChange(Number(event.target.value.replace(/[^0-9]/g, '')))} />
    </label>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
