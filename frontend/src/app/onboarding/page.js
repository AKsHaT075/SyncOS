"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function OnboardingPage() {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-2xl">Welcome to Sync OS</CardTitle>
        <CardDescription>What would you like to do?</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button asChild size="lg">
          <Link href="/onboarding/create-organization">Create Organization</Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/onboarding/join-organization">Join Organization</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
