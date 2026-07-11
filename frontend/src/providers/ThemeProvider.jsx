"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

// Most of the dashboard shell (Topbar, role-specific dashboard views, cards)
// is hardcoded to light-mode colors and doesn't reference the dark-aware
// semantic tokens — only Projects/Tasks pages do. Letting next-themes flip
// to dark based on OS preference (enableSystem) made those two pages look
// broken relative to the rest of the app. Forced to light until the rest of
// the dashboard is migrated to semantic tokens.
export default function ThemeProvider({ children }) {
  return (
    <NextThemesProvider attribute="class" forcedTheme="light">
      {children}
    </NextThemesProvider>
  );
}
