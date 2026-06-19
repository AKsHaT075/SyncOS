import PublicRoute from "@/components/auth/PublicRoute";
import ResetPasswordForm from "@/features/auth/components/ResetPasswordForm";

export default async function ResetPasswordPage({ searchParams }) {
  const params = await searchParams;

  return (
    <PublicRoute>
      <ResetPasswordForm
        initialEmail={params?.email || ""}
        initialToken={params?.token || ""}
      />
    </PublicRoute>
  );
}
