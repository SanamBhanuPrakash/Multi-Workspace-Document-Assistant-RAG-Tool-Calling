import type { Metadata } from "next";
import { AuthForm } from "@/ui/auth-form";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage() {
  return <AuthForm mode="signup" />;
}
