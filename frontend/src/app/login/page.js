import PublicRoute from "@/components/auth/PublicRoute";
import LoginForm from "@/features/auth/components/LoginForm";

export default function LoginPage() {
  return (
    <PublicRoute>
      <LoginForm />
    </PublicRoute>
  );
}
