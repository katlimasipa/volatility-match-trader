import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { session } from "@/lib/deriv-config";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const localUser = session.get();
    if (localUser) return;

    try {
      const { data } = await supabase.auth.getUser();
      if (!data.user) throw redirect({ to: "/" });
      session.set(data.user.email || "trader");
    } catch {
      throw redirect({ to: "/" });
    }
  },
  component: () => <Outlet />,
});
