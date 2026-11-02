import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/services/session";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  redirect(user.tenantId ? "/app" : "/admin");
}
