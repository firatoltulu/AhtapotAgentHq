import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AuthStatus } from "@ahtapot/shared";

import { UNAUTHORIZED_EVENT, api } from "../api";
import { currentSubscription, disablePush, enablePush, pushSupport } from "../push";
import { Button, Dot, ErrorText, Field, Input, Modal } from "../ui";

/**
 * Giriş kapısı ve güvenlik ayarları.
 *
 * Akış sunucunun `next` alanından okunur, UI kuralı yeniden yazmaz:
 * token tanımlıysa önce token, TOTP bağlıysa ardından kod. İkisi de yoksa
 * kapı hiç görünmez (sunucu açık) — bunun yerine kabukta uyarı çıkar.
 */

export const AUTH_KEY = ["auth"] as const;

export function useAuthStatus() {
  return useQuery({ queryKey: AUTH_KEY, queryFn: api.authStatus, staleTime: 60_000, retry: 1 });
}

/** Oturum açılmadan uygulamanın kendisi hiç render edilmez — boş ekranlar ve 401 yağmuru olmasın. */
export function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const status = useAuthStatus();

  // Herhangi bir istek 401 alırsa (süre doldu, başka cihazda 2FA bağlandı)
  // durum yeniden sorulur ve kapı kendiliğinden geri gelir.
  useEffect(() => {
    const onUnauthorized = () => void qc.invalidateQueries({ queryKey: AUTH_KEY });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [qc]);

  if (status.isPending) return <Splash>sunucuya bağlanılıyor…</Splash>;
  if (status.isError) {
    return (
      <Splash>
        <span>Sunucuya ulaşılamıyor.</span>
        <Button size="sm" onClick={() => void status.refetch()}>Tekrar dene</Button>
      </Splash>
    );
  }
  if (!status.data.authenticated) return <LoginScreen status={status.data} />;
  return <>{children}</>;
}

function Splash({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-canvas text-[13px] text-ink-muted">
      {children}
    </div>
  );
}

function LoginScreen({ status }: { status: AuthStatus }) {
  const qc = useQueryClient();
  const [token, setToken] = useState("");
  const [code, setCode] = useState("");

  /** Tam oturum açılınca her şey yeniden sorulur: önceki 401'ler hata durumunda kalmasın. */
  const done = (s: AuthStatus) => {
    qc.setQueryData(AUTH_KEY, s);
    if (s.authenticated) void qc.invalidateQueries();
  };

  const login = useMutation({ mutationFn: () => api.login(token), onSuccess: (s) => { setToken(""); done(s); } });
  const totp = useMutation({ mutationFn: () => api.loginTotp(code), onSuccess: done, onError: () => setCode("") });

  const step = status.next;
  const steps = [status.tokenConfigured && "token", status.totpEnabled && "totp"].filter(Boolean) as string[];
  const index = step ? steps.indexOf(step) + 1 : steps.length;

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-[380px] rounded-2xl border border-edge-strong bg-surface p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2.5">
          <img src="/icon.svg" alt="" className="h-7 w-7" />
          <div className="flex flex-col">
            <span className="text-[15px] font-semibold text-ink">Oturum aç</span>
            {steps.length > 1 && (
              <span className="font-mono text-[11px] text-ink-muted">adım {index}/{steps.length}</span>
            )}
          </div>
        </div>

        {step === "token" && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (token) login.mutate();
            }}
          >
            <Field label="Yönetici token'ı">
              <Input
                type="password"
                autoFocus
                autoComplete="current-password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="AHTAPOT_ADMIN_TOKEN"
              />
            </Field>
            <Button variant="primary" type="submit" disabled={!token || login.isPending}>
              {login.isPending ? "doğrulanıyor…" : "Devam"}
            </Button>
            <ErrorText error={login.error} />
          </form>
        )}

        {step === "totp" && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (code.length >= 6) totp.mutate();
            }}
          >
            <p className="text-[13px] leading-relaxed text-ink-soft">
              Kimlik doğrulayıcı uygulamanızdaki 6 haneli kodu girin.
            </p>
            <CodeInput value={code} onChange={setCode} onComplete={() => totp.mutate()} />
            <Button variant="primary" type="submit" disabled={code.length < 6 || totp.isPending}>
              {totp.isPending ? "doğrulanıyor…" : "Giriş yap"}
            </Button>
            <ErrorText error={totp.error} />
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * 6 haneli kod alanı. `one-time-code`: iOS/Android klavyesi kodu önerebiliyor;
 * altıncı hanede kendiliğinden gönderir — telefonda "Giriş"e basmaya gerek kalmasın.
 */
function CodeInput({ value, onChange, onComplete }: { value: string; onChange: (v: string) => void; onComplete?: () => void }) {
  return (
    <Input
      autoFocus
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      maxLength={6}
      value={value}
      onChange={(e) => {
        const v = e.target.value.replace(/\D/g, "").slice(0, 6);
        onChange(v);
        if (v.length === 6 && value.length < 6) onComplete?.();
      }}
      placeholder="000000"
      className="h-11 text-center font-mono text-[20px] tracking-[.4em]"
    />
  );
}

// ── Güvenlik paneli ──────────────────────────────────────────────────────────

/** Üst şeritteki düğme: doğrulama yoksa ya da 2FA bağlı değilse uyarı tonunda. */
export function SecurityButton() {
  const status = useAuthStatus();
  const [open, setOpen] = useState(false);
  const s = status.data;
  const tone = !s ? "off" : s.open ? "err" : s.totpEnabled ? "ok" : "wait";
  const label = !s ? "güvenlik" : s.open ? "doğrulama yok" : s.totpEnabled ? "2FA ✓" : "2FA yok";
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-[7px] rounded-lg border border-edge-control bg-surface px-2.5 py-1 font-mono text-[11px] text-ink-muted hover:bg-raised"
        title="Güvenlik ve bildirimler"
      >
        <Dot tone={tone} />
        {label}
      </button>
      {open && s && <SecurityModal status={s} onClose={() => setOpen(false)} />}
    </>
  );
}

function SecurityModal({ status, onClose }: { status: AuthStatus; onClose: () => void }) {
  // Tam sayfa yenileme: bellekteki sorgu önbelleği ve açık WS'ler de gitsin.
  // `qc.clear()` gözlemcisi olan auth sorgusunu da siliyor ve yeniden
  // sorgulatmıyordu — ekran giriş kapısına dönmüyordu (ölçüldü).
  const logout = useMutation({ mutationFn: api.logout, onSuccess: () => location.replace("/") });

  return (
    <Modal
      title="Güvenlik ve bildirimler"
      subtitle="İki adımlı doğrulama ve agent sizi beklediğinde telefon bildirimi"
      onClose={onClose}
      width={600}
      footer={
        <>
          <div className="flex-1" />
          {!status.open && (
            <Button variant="danger" size="sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
              Oturumu kapat
            </Button>
          )}
          <Button size="sm" onClick={onClose}>Kapat</Button>
        </>
      }
    >
      {status.open && (
        <div className="rounded-lg border border-err-edge bg-err-tint px-3 py-2 text-[12.5px] leading-relaxed text-err-text">
          Sunucuda hiçbir doğrulama yok: adrese ulaşan herkes işleri görebilir ve onaylayabilir.
          <code className="mx-1 font-mono">AHTAPOT_ADMIN_TOKEN</code> tanımlayın ya da aşağıdan iki adımlı
          doğrulamayı bağlayın.
        </div>
      )}
      <TotpSection status={status} />
      <PushSection />
    </Modal>
  );
}

function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-edge p-4">
      <header className="flex items-center justify-between gap-3">
        <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
        {right}
      </header>
      {children}
    </section>
  );
}

function TotpSection({ status }: { status: AuthStatus }) {
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [removing, setRemoving] = useState(false);
  const setup = useMutation({ mutationFn: api.totpSetup });
  const onStatus = (s: AuthStatus) => {
    qc.setQueryData(AUTH_KEY, s);
    setCode("");
    setup.reset();
    setRemoving(false);
  };
  const confirm = useMutation({ mutationFn: () => api.totpConfirm(code), onSuccess: onStatus, onError: () => setCode("") });
  const disable = useMutation({ mutationFn: () => api.totpDisable(code), onSuccess: onStatus, onError: () => setCode("") });

  if (status.totpEnabled) {
    return (
      <Section title="İki adımlı doğrulama" right={<span className="flex items-center gap-1.5 font-mono text-[11px] text-ok-ink"><Dot tone="ok" />bağlı</span>}>
        <p className="text-[12.5px] leading-relaxed text-ink-soft">
          Girişte {status.tokenConfigured ? "token'dan sonra " : ""}kimlik doğrulayıcı kodu soruluyor. Telefonu
          kaybederseniz sunucuyu <code className="font-mono">AHTAPOT_RESET_2FA=1</code> ile bir kez başlatın.
        </p>
        {!removing ? (
          <div>
            <Button variant="danger" size="sm" onClick={() => setRemoving(true)}>Kaldır…</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <span className="text-[12.5px] text-ink-body">Kaldırmak için güncel kodu girin:</span>
            <div className="flex gap-2">
              <CodeInput value={code} onChange={setCode} />
              <Button variant="danger-solid" onClick={() => disable.mutate()} disabled={code.length < 6 || disable.isPending}>
                Kaldır
              </Button>
            </div>
            <ErrorText error={disable.error} />
          </div>
        )}
      </Section>
    );
  }

  return (
    <Section title="İki adımlı doğrulama" right={<span className="flex items-center gap-1.5 font-mono text-[11px] text-wait-ink"><Dot tone="wait" />bağlı değil</span>}>
      {!setup.data ? (
        <>
          <p className="text-[12.5px] leading-relaxed text-ink-soft">
            Google Authenticator, Microsoft Authenticator, 1Password gibi bir uygulamayla bağlayın. Bağlandıktan sonra
            {status.tokenConfigured ? " token'dan sonra" : ""} her girişte 6 haneli kod sorulur; diğer tüm oturumlar kapatılır.
          </p>
          <div>
            <Button variant="primary" size="sm" onClick={() => setup.mutate()} disabled={setup.isPending}>
              {setup.isPending ? "hazırlanıyor…" : "Bağla"}
            </Button>
          </div>
          <ErrorText error={setup.error} />
        </>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <img
            src={setup.data.qrDataUrl}
            alt="TOTP QR kodu"
            className="h-[168px] w-[168px] shrink-0 self-center rounded-lg border border-edge bg-white p-1"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <span className="text-[12.5px] leading-relaxed text-ink-body">
              1. Uygulamada QR kodu okutun. Okutamıyorsanız anahtarı elle girin:
            </span>
            <code className="rounded-md bg-chip px-2 py-1 font-mono text-[12px] break-all text-ink select-all">
              {setup.data.secret.replace(/(.{4})/g, "$1 ").trim()}
            </code>
            <span className="text-[12.5px] text-ink-body">2. Uygulamanın gösterdiği kodu girin:</span>
            <div className="flex gap-2">
              <CodeInput value={code} onChange={setCode} onComplete={() => confirm.mutate()} />
              <Button variant="primary" onClick={() => confirm.mutate()} disabled={code.length < 6 || confirm.isPending}>
                Onayla
              </Button>
            </div>
            <ErrorText error={confirm.error} />
          </div>
        </div>
      )}
    </Section>
  );
}

function PushSection() {
  const status = useQuery({ queryKey: ["push"], queryFn: api.pushStatus });
  const device = useQuery({ queryKey: ["push", "device"], queryFn: currentSubscription });
  const qc = useQueryClient();
  const support = pushSupport();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["push"] });

  const enable = useMutation({ mutationFn: enablePush, onSettled: refresh });
  const disable = useMutation({ mutationFn: disablePush, onSettled: refresh });
  const test = useMutation({ mutationFn: api.pushTest });

  const subscribed = Boolean(device.data);

  return (
    <Section
      title="Telefon bildirimleri"
      right={
        <span className="font-mono text-[11px] text-ink-muted">
          {status.data ? `${status.data.subscriptions} cihaz${status.data.ntfy ? " + ntfy" : ""}` : ""}
        </span>
      }
    >
      <p className="text-[12.5px] leading-relaxed text-ink-soft">
        Bir onay kapısı açıldığında, agent soru sorduğunda ya da iş dikkat istediğinde bildirim gelir. Her cihazda
        ayrı açılır.
      </p>
      {!support.ok ? (
        <div className="rounded-lg border border-wait-edge bg-wait-tint px-3 py-2 text-[12.5px] leading-relaxed text-wait-ink">
          {support.reason}
          {status.data?.ntfy
            ? " Sunucuda ntfy tanımlı — bildirimler ntfy uygulamasına yine gidiyor."
            : " Alternatif: sunucuda AHTAPOT_NTFY_URL tanımlayıp telefonda ntfy uygulamasıyla aynı konuya abone olun."}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {subscribed ? (
            <Button size="sm" variant="danger" onClick={() => disable.mutate()} disabled={disable.isPending}>
              Bu cihazda kapat
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => enable.mutate()} disabled={enable.isPending}>
              {enable.isPending ? "izin isteniyor…" : "Bu cihazda aç"}
            </Button>
          )}
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-ink-muted">
            <Dot tone={subscribed ? "ok" : "off"} />
            {subscribed ? "bu cihaz kayıtlı" : "bu cihaz kayıtlı değil"}
          </span>
        </div>
      )}
      {(subscribed || status.data?.ntfy) && (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
            Deneme bildirimi gönder
          </Button>
          {test.isSuccess && <span className="text-[12px] text-ok-ink">gönderildi</span>}
        </div>
      )}
      <ErrorText error={enable.error ?? disable.error ?? test.error} />
    </Section>
  );
}
