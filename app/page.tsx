
import { getActors } from '@/app/actions';
import ActorRunner from '@/components/ActorRunner';
import { Toaster } from "@/components/ui/sonner"

export default async function Home() {
  const actors = await getActors();

  return (
    <main className="min-h-screen bg-slate-50 dark:bg-slate-950 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-100 via-slate-50 to-slate-100 dark:from-slate-900 dark:via-slate-950 dark:to-black py-10 selection:bg-blue-100 selection:text-blue-900">
      <ActorRunner actors={actors} />
      <Toaster position="top-right" />
    </main>
  );
}
