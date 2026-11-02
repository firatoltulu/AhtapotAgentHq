import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api, type Job } from "../api";
import { Button, ErrorText, Textarea } from "../ui";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `KEY=değer` satırları; `#` yorum ve boş satır atlanır. `.env` yapıştırılabilsin diye. */
export function parseEnvText(text: string): { env: Record<string, string>; errors: string[] } {
  // Prototipsiz: `__proto__`/`constructor` gibi adlar sıradan anahtar kalsın.
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  const errors: string[] = [];
  // `\r\n`: Windows'tan yapıştırılan metinde `\r` değere yapışırdı (`db\r`).
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    const name = (eq < 0 ? line : line.slice(0, eq)).trim();
    if (eq < 0) return void errors.push(`${i + 1}. satır: '=' yok`);
    if (!NAME.test(name) || name === "__proto__") return void errors.push(`${i + 1}. satır: geçersiz ad '${name}'`);
    if (Object.hasOwn(env, name)) errors.push(`${i + 1}. satır: '${name}' iki kez yazılmış — sonuncusu geçerli`);
    // Değer olduğu gibi: baştaki/sondaki boşluk da anlamlı olabilir (bkz. profil `emptyEnv`).
    env[name] = raw.slice(raw.indexOf("=") + 1);
  });
  return { env, errors };
}

export function formatEnv(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
}

/**
 * İşe özel canlı ortam değişkenleri.
 *
 * Profil tüm işlere ortak; tek bir işin canlı ortamını farklı bir uca ya da
 * bayrağa bağlamak profili değiştirmeyi gerektiriyordu. Buradaki değerler
 * profilin ve orkestratörün (DB bağlantısı dahil) değerlerini ezer. Koşan
 * ortama geçmez: `onApply` verilmişse "Kaydet ve yeniden kaldır" sunulur.
 */
export function LiveEnvCard({
  job,
  hint,
  onApply,
  applying = false,
}: {
  job: Job;
  hint: string;
  /** Kaydettikten sonra ortamı yeniden kaldır (LiveTest) ya da yeniden dene (NeedsAttention). */
  onApply?: { label: string; run: () => void };
  applying?: boolean;
}) {
  const qc = useQueryClient();
  const saved = formatEnv(job.liveEnv ?? {});
  const [text, setText] = useState(saved);
  // Sunucudan yeni değer geldiğinde (başka sekme, kaydetme) düzenleme yoksa eşitle.
  const [base, setBase] = useState(saved);
  // Başka işe geçilince kaydedilmemiş metin TAŞINMAZ: aksi hâlde "Kaydet"
  // önceki işin değerlerini (çoğu zaman sır) bu işe yazardı.
  const [baseJob, setBaseJob] = useState(job.id);
  useEffect(() => {
    if (job.id !== baseJob) {
      setText(saved);
      setBase(saved);
      setBaseJob(job.id);
    } else if (saved !== base) {
      if (text === base) setText(saved);
      setBase(saved);
    }
  }, [job.id, baseJob, saved, base, text]);

  const parsed = parseEnvText(text);
  const blocking = parsed.errors.filter((e) => !e.includes("iki kez"));
  const dirty = text !== saved;

  const save = useMutation({
    mutationFn: () => api.setLiveEnv(job.id, parsed.env),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["job", job.id] }),
  });
  const saveThen = (after?: () => void) => {
    if (!dirty) return after?.();
    save.mutate(undefined, { onSuccess: () => after?.() });
  };

  const count = Object.keys(job.liveEnv ?? {}).length;
  return (
    <div className="flex max-w-[840px] flex-col gap-2 rounded-xl border border-edge bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-ink">İşe özel ortam değişkenleri</span>
        <span className="font-mono text-[11.5px] text-ink-muted">{count > 0 ? `${count} değişken` : "yok — profil geçerli"}</span>
      </div>
      <Textarea
        rows={Math.min(12, Math.max(3, text.split("\n").length + 1))}
        value={text}
        spellCheck={false}
        placeholder={"ConnectionStrings__Redis=redis:6379\nFeatureFlags__NewCheckout=true"}
        onChange={(e) => setText(e.target.value)}
        className="font-mono text-[12px]"
      />
      {parsed.errors.length > 0 && (
        <ul className="list-disc pl-5 font-mono text-[11.5px] text-err-text">
          {parsed.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <p className="text-[12px] leading-relaxed text-ink-soft">{hint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="neutral" size="sm" disabled={!dirty || blocking.length > 0 || save.isPending} onClick={() => saveThen()}>
          {save.isPending ? "kaydediliyor…" : "Kaydet"}
        </Button>
        {onApply && (
          <Button
            variant="primary"
            size="sm"
            disabled={blocking.length > 0 || save.isPending || applying}
            onClick={() => saveThen(onApply.run)}
          >
            {applying ? "uygulanıyor…" : dirty ? `Kaydet ve ${onApply.label.toLowerCase()}` : onApply.label}
          </Button>
        )}
        {dirty && (
          <Button variant="ghost" size="sm" onClick={() => setText(saved)}>
            Geri al
          </Button>
        )}
      </div>
      <ErrorText error={save.error} />
    </div>
  );
}
