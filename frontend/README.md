# Sync OS — Frontend

Next.js 15 (App Router), JavaScript, Tailwind CSS, shadcn/ui, TanStack Query, Zustand, React Hook Form + Zod.

```bash
npm install
cp .env.example .env.local     # NEXT_PUBLIC_API_URL, NEXT_PUBLIC_CSRF_COOKIE_NAME
npm run dev                    # http://localhost:3000 (the API must be running on :5001)
npm run lint
npm test                       # node --test on the pure AI utilities (tests/ai)
```

Layout: `src/app` (routes), `src/features/<module>` (components, hooks, services, schemas), `src/components` (shared UI, layout, dashboards), `src/lib` (Axios client), `src/store` (Zustand), `src/constants` (roles and permissions, mirrored from the backend).

Architecture, module list and conventions: [../docs/architecture.md](../docs/architecture.md), [../docs/modules.md](../docs/modules.md), [../docs/development.md](../docs/development.md).
