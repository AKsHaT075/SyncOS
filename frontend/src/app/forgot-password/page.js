import PublicRoute from "@/components/auth/PublicRoute";
import ForgotPasswordForm from "@/features/auth/components/ForgotPasswordForm";

export default function ForgotPasswordPage() {
  return (
    <PublicRoute>
      <ForgotPasswordForm />
    </PublicRoute>
  );
}
