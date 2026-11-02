import { useState } from "react";

import { Button, Input } from "../../ui";

/**
 * `Record<string,string>` düzenleyicisi — `SchemaField`'ın `record` dalı,
 * value tipi string olduğunda buraya yönlenir. Tek widget, 5+ farklı yerde
 * (`CommandSchema.env`, `ExecSchema.env`, `TestSuiteSchema.services[].env`,
 * `appEnv`, `ServiceSchema.env`) tekrar kullanılır.
 *
 * Anahtar adında PASSWORD/SECRET/TOKEN/KEY/CONNECTION STRING geçen satırların
 * değeri `type="password"` — veri gizleme DEĞİL (`scrubSecrets` yalnız server
 * log'una uygulanır, kullanıcı kendi girdiği değeri görüp düzeltebilmeli),
 * yalnız omuz-sörfü/ekran paylaşımı sırasında kazara ifşayı azaltan bir önlem.
 * Göster/gizle toggle'ı her satırda ayrı tutulur.
 */
const SECRET_KEY_PATTERN = /PASSWORD|SECRET|TOKEN|KEY|CONNECTION.?STRING/i;

export function EnvTable({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const entries = Object.entries(value ?? {});
  // ANAHTAR bazlı, İNDEKS değil: bir satır silinince sonrakilerin indeksi
  // kayar — indeks tutulsaydı başka bir satır (belki başka bir secret)
  // yanlışlıkla "gizli" durumdan çıkardı (CodeRabbit). Anahtar sabit kaldığı
  // sürece bu satırın gizlilik durumu doğru satırla eşleşmeye devam eder.
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [renameError, setRenameError] = useState<number | null>(null);

  function renameKey(index: number, newKey: string) {
    // Boş ya da BAŞKA bir satırla çakışan anahtar reddedilir — aksi hâlde
    // `next[newKey] = v` iki kaydı tek property altında birleştirir ve
    // birinin değeri sessizce kaybolur (CodeRabbit, gerçek veri kaybı).
    const collides = entries.some(([k], i) => i !== index && k === newKey);
    if (!newKey || collides) {
      setRenameError(index);
      return;
    }
    setRenameError((e) => (e === index ? null : e));
    const oldKey = entries[index]?.[0];
    if (oldKey !== undefined) {
      setRevealed((s) => {
        if (!s.has(oldKey)) return s;
        const next = new Set(s);
        next.delete(oldKey);
        next.add(newKey);
        return next;
      });
    }
    const next: Record<string, string> = {};
    entries.forEach(([k, v], i) => {
      next[i === index ? newKey : k] = v;
    });
    onChange(next);
  }

  function setValueAt(index: number, newValue: string) {
    const next: Record<string, string> = {};
    entries.forEach(([k, v], i) => {
      next[k] = i === index ? newValue : v;
    });
    onChange(next);
  }

  function removeAt(index: number) {
    const next: Record<string, string> = {};
    entries.forEach(([k, v], i) => {
      if (i !== index) next[k] = v;
    });
    onChange(next);
  }

  function add() {
    // Aynı boş anahtarla üstüne yazmamak için sayaçlı, kullanıcı hemen değiştirir.
    let i = 1;
    let key = "YENİ_DEĞİŞKEN";
    while (key in value) key = `YENİ_DEĞİŞKEN_${i++}`;
    onChange({ ...value, [key]: "" });
  }

  return (
    <div className="flex flex-col gap-1.5">
      {entries.length === 0 && <div className="text-[12px] text-ink-dim">değişken yok</div>}
      {entries.map(([k, v], i) => {
        const isSecret = SECRET_KEY_PATTERN.test(k);
        const isRevealed = revealed.has(k);
        return (
          <div key={i} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
            <Input
              className={`flex-1 font-mono text-[12px] ${renameError === i ? "border-err-edge" : ""}`}
              value={k}
              onChange={(e) => renameKey(i, e.target.value)}
              placeholder="ANAHTAR"
            />
            <Input
              className="flex-[2] font-mono text-[12px]"
              type={isSecret && !isRevealed ? "password" : "text"}
              value={v}
              onChange={(e) => setValueAt(i, e.target.value)}
              placeholder="değer"
            />
            {isSecret && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setRevealed((s) => {
                    const next = new Set(s);
                    if (next.has(k)) next.delete(k);
                    else next.add(k);
                    return next;
                  })
                }
              >
                {isRevealed ? "gizle" : "göster"}
              </Button>
            )}
            <Button type="button" variant="danger" size="sm" onClick={() => removeAt(i)}>
              sil
            </Button>
            </div>
            {renameError === i && (
              <span className="text-[11px] text-err-ink">anahtar boş olamaz ya da zaten kullanılıyor</span>
            )}
          </div>
        );
      })}
      <Button type="button" variant="ghost" size="sm" onClick={add} className="self-start">
        + değişken ekle
      </Button>
    </div>
  );
}
