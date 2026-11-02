import { NavLink, Outlet } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { api } from "./api";
import { SecurityButton } from "./components/Auth";
import { Toaster } from "./toast";
import { Dot, fmtVersion } from "./ui";

/**
 * Kabuk: 52px üst şerit + içerik.
 *
 * Üst şerit tasarımdan: marka, aktif bölüm, sağda canlı sistem göstergeleri
 * (WS/kimlik havuzu/maliyet). Giriş kabuğun DIŞINDA (`AuthGate`); buradaki
 * düğme yalnız 2FA/bildirim ayarlarını ve oturum kapatmayı açar.
 */
export function Layout() {
  const system = useQuery({ queryKey: ["system"], queryFn: api.system, refetchInterval: 30_000 });

  const link = ({ isActive }: { isActive: boolean }) =>
    `rounded-lg px-2.5 py-1 text-[13px] font-medium transition-colors ${
      isActive ? "bg-brand-tint text-brand" : "text-ink-soft hover:text-ink"
    }`;

  const ids = system.data?.identities;

  return (
    // `h-dvh`, `h-screen` değil: mobil tarayıcıda 100vh adres çubuğunu da
    // sayıyor, kabuk görünen alandan uzun kalıyor ve iç kaydırıcılar (plan,
    // diff) yerine sayfanın kendisi kayıyordu (yaşandı, Plan sekmesi).
    <div className="flex h-dvh flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-4 border-b border-edge bg-sunken px-4">
        <div className="flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="h-5 w-5" />
          <span className="text-[14.5px] font-semibold text-ink">{system.data?.brand ?? "AhtapotAgent"}</span>
          {system.data?.version && (
            <span className="font-mono text-[11px] text-ink-muted" title="Çalışan sürüm">
              {fmtVersion(system.data.version)}
            </span>
          )}
        </div>

        <nav className="flex items-center gap-1">
          <NavLink to="/" end className={link}>
            Projeler
          </NavLink>
          <NavLink to="/jobs" className={link}>
            İşler
          </NavLink>
        </nav>

        <div className="flex-1" />

        <div className="flex items-center gap-4">
          <span className="flex items-center gap-[7px] font-mono text-[12px] text-ink-muted">
            <Dot tone={system.isError ? "err" : "ok"} pulse={system.isFetching} />
            {system.isError ? "sunucuya ulaşılamıyor" : "sunucu bağlı"}
          </span>
          {ids && (
            <span className="flex items-center gap-[7px] font-mono text-[12px] text-ink-muted">
              <Dot tone={ids.available === 0 ? "err" : ids.available < ids.total ? "wait" : "ok"} />
              kimlik {ids.available}/{ids.total}
            </span>
          )}
          {system.data && (
            <span className="hidden font-mono text-[12px] text-ink-muted md:inline">koşan {system.data.jobs.running}</span>
          )}
          {system.data && (
            <span
              className={`hidden rounded-lg border bg-surface px-[9px] py-1 font-mono text-[11px] md:inline ${
                system.data.github.token ? "border-edge-control text-ink-muted" : "border-err-edge text-err-ink"
              }`}
              title={system.data.github.token ? "Sunucunun GitHub kimliği var" : "Sunucuda GH_TOKEN / gh oturumu yok — push ve PR düşer"}
            >
              gh token {system.data.github.token ? "✓" : "yok"}
            </span>
          )}
          <SecurityButton />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
      <Toaster />
    </div>
  );
}
