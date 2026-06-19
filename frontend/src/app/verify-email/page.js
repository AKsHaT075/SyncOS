import PublicRoute from "@/components/auth/PublicRoute";
import VerifyOtpForm from "@/features/auth/components/VerifyOtpForm";

export default async function VerifyEmailPage({ searchParams }) {
  const params = await searchParams;

  return (
    <PublicRoute>
      <VerifyOtpForm initialEmail={params?.email || ""} />
    </PublicRoute>
  );
}
