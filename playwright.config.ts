import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  use: { baseURL: 'http://localhost:4175' },
  webServer: {
    command: 'npm run preview -- --port 4175',
    url: 'http://localhost:4175',
    reuseExistingServer: false,
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: 'app.spec.ts',
      use: { browserName: 'chromium' },
    },
    ...[
      { width: 390, height: 844 },
      { width: 820, height: 1180 },
      { width: 1280, height: 800 },
    ].map((viewport) => ({
      name: `builder-${viewport.width}x${viewport.height}`,
      testMatch: 'app.spec.ts',
      use: { browserName: 'chromium' as const, viewport },
    })),
  ],
});
