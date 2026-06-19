"use client";

import { Toaster } from "sonner";
import QueryProvider from "@/providers/QueryProvider";
import AuthProvider from "@/providers/AuthProvider";

export default function AppProviders({ children }) {
  return (
    <QueryProvider>
      <AuthProvider>
        {children}
        <Toaster richColors position="top-right" />
      </AuthProvider>
    </QueryProvider>
  );
}
