import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/household_budget_management_forbaby/',
  build: {
    outDir: 'dist',
  },
});
