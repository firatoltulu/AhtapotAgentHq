import { useState, type ReactNode } from "react";

import type { ProjectProfile } from "@ahtapot/shared";

import { Dot, Tag } from "../ui";

/**
 * Profil belgesi — okunur görünüm.
 *
 * Ham JSON operatöre "bu profille ne olacak" sorusunu cevaplatmıyordu; bu
 * ekranda verilen karar (onayla/reddet) her işi etkilediği için belgenin
 * kendisi okunabilir olmalı.
 *
 * Düzen, insanın sorduğu sıraya göre: nereden kod gelecek, nasıl derlenecek,
 * ne koşulacak, nasıl ayağa kalkacak, neye dokunulmayacak, kim ne kadar
 * harcayacak. Tehlikeli alanlar (yasak bayrak, asla kopyalanmaz, tek boşluk)
 * vurgulanır — gözden kaçarsa pahalıya patlayanlar onlar.
 */

function Row({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-3 py-[3px] text-[12.5px]">
      <span className="w-[136px] shrink-0 text-ink-muted">{label}</span>
      <span className={`aht-wrap min-w-0 flex-1 text-ink-body ${mono ? "font-mono text-[11.5px]" : ""}`}>{children}</span>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-edge bg-raised">
      <header className="flex items-baseline gap-2.5 border-b border-edge px-3.5 py-2">
        <h3 className="text-[12.5px] font-semibold text-ink">{title}</h3>
        {note && <span className="text-[11.5px] text-ink-muted">{note}</span>}
      </header>
      <div className="px-3.5 py-2.5">{children}</div>
    </section>
  );
}

/** Tehlike vurgusu: gözden kaçarsa pahalıya patlayan alanlar. */
function Danger({ children }: { children: ReactNode }) {
  return <span className="rounded-md bg-err-tint px-1.5 py-0.5 font-mono text-[11px] text-err-ink">{children}</span>;
}

function List({ items, empty = "—" }: { items: string[]; empty?: string }) {
  if (items.length === 0) return <span className="text-ink-muted">{empty}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((x) => (
        <Tag key={x} className="bg-chip font-mono text-[11px] text-ink-body">
          {x}
        </Tag>
      ))}
    </span>
  );
}

/** Komut satırı: uzun olabilir, sarmalı ve tam görünmeli. */
function Cmd({ run }: { run: string }) {
  return <code className="aht-wrap block rounded-lg bg-log px-2 py-1 font-mono text-[11px] leading-[1.55] text-ink-body">{run}</code>;
}

export function ProfileDoc({ doc }: { doc: ProjectProfile }) {
  const [raw, setRaw] = useState(false);
  const primary = doc.workspace.repos.find((r) => r.primary);

  if (raw) {
    return (
      <div>
        <button onClick={() => setRaw(false)} className="mb-2 text-[12px] text-brand hover:underline">
          ← okunur görünüm
        </button>
        <pre className="aht-wrap max-h-[70vh] overflow-auto rounded-xl border border-edge bg-log p-3 font-mono text-[11px] leading-[1.6] text-ink-body">
          {JSON.stringify(doc, null, 2)}
        </pre>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] text-ink-muted">
          {doc.name} · <span className="font-mono text-[11.5px]">{doc.slug}</span>
        </span>
        <span className="flex-1" />
        <button onClick={() => setRaw(true)} className="text-[12px] text-ink-muted hover:text-brand hover:underline">
          ham JSON
        </button>
      </div>

      <Section title="Çalışma alanı" note="kod nereden gelecek">
        <Row label="Kök" mono>
          {doc.workspace.root}
        </Row>
        {doc.workspace.repos.map((r) => (
          <Row key={r.name} label={r.primary ? "Repo (primary)" : "Repo"} mono>
            {r.path} · dal {r.defaultBranch}
            {r.remote ? ` · ${r.remote}` : " · remote yok"}
          </Row>
        ))}
        <Row label="Worktree'ye kopyala">
          <List items={doc.workspace.ignoredButNeeded} empty="yok" />
          <span className="mt-0.5 block text-[11.5px] text-ink-muted">
            gitignore'lu ama gerekli; `git worktree add` bunları taşımaz
          </span>
        </Row>
      </Section>

      <Section title="Derleme" note="sıra bağlayıcıdır">
        {doc.build.preSteps.length > 0 && (
          <div className="mb-2">
            <div className="mb-1 text-[11.5px] text-ink-muted">Ön adımlar (her zaman koşar)</div>
            {doc.build.preSteps.map((s) => (
              <div key={s.name} className="mb-1.5">
                <div className="text-[12px] text-ink">{s.name}</div>
                <Cmd run={s.run} />
              </div>
            ))}
          </div>
        )}
        <div className="mb-1 text-[11.5px] text-ink-muted">Adımlar</div>
        {doc.build.steps.map((s, i) => (
          <div key={s.name} className="mb-2">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[11px] text-ink-muted">{i + 1}.</span>
              <span className="text-[12px] text-ink">{s.name}</span>
              {s.whenChanged.length === 0 && <span className="text-[11px] text-ink-muted">koşulsuz</span>}
            </div>
            <Cmd run={s.run} />
            {s.whenChanged.length > 0 && (
              <div className="mt-0.5 flex flex-wrap items-baseline gap-1 text-[11.5px] text-ink-muted">
                <span>koşar:</span>
                <List items={s.whenChanged} />
                {s.exceptPaths.length > 0 && (
                  <>
                    <span>· istisna:</span>
                    <List items={s.exceptPaths} />
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        {doc.build.forbiddenFlags.length > 0 && (
          <Row label="Yasak bayrak">
            <span className="flex flex-wrap gap-1">
              {doc.build.forbiddenFlags.map((f) => (
                <Danger key={f}>{f}</Danger>
              ))}
            </span>
            <span className="mt-0.5 block text-[11.5px] text-ink-muted">komutta geçerse iş reddedilir</span>
          </Row>
        )}
      </Section>

      <Section title="Testler" note={doc.test.caseApproval ? "case listesi insana sorulur" : "case onayı kapalı"}>
        {doc.test.suites.length === 0 && <span className="text-[12.5px] text-ink-muted">Tanımlı takım yok.</span>}
        {doc.test.suites.map((s) => (
          <div key={s.id} className="mb-2">
            <div className="flex items-baseline gap-2">
              <span className="text-[12px] font-medium text-ink">{s.id}</span>
              <span className="text-[11.5px] text-ink-muted">
                {s.runAt === "qa" ? "QA aşamasında" : s.runAt === "phase" ? "safha sonunda" : "elle"}
                {s.report.format !== "exitcode" ? ` · ${s.report.format} raporu` : " · yalnız çıkış kodu"}
              </span>
            </div>
            <Cmd run={s.command.run} />
            {s.services.length > 0 && (
              <div className="mt-0.5 text-[11.5px] text-ink-muted">
                servis ister: {s.services.join(", ")}
                {s.cloneDb && " · her koşuda şablondan taze DB klonu"}
              </div>
            )}
            {s.preSteps.map((p) => (
              <div key={p.name} className="mt-1">
                <div className="text-[11.5px] text-wait-ink">ön adım — atlanırsa testler yanlış yönde geçebilir</div>
                <Cmd run={p.run} />
              </div>
            ))}
          </div>
        ))}
        <Row label="Baseline">
          {doc.test.baseline ? "açık — önceden kırık testler ayrılır" : "kapalı"}
        </Row>
      </Section>

      {doc.live?.enabled && (
        <Section title="Canlı ortam" note="insanın porttan test ettiği yer">
          <Row label="Uygulama" mono>
            {doc.live.app.service ?? "app"} · konteyner portu {doc.live.app.containerPort}
          </Row>
          {doc.live.compose && (
            <Row label="Compose" mono>
              {doc.live.compose.base}
            </Row>
          )}
          <Row label="Servisler">
            {doc.live.services.length === 0 ? (
              <span className="text-ink-muted">yok</span>
            ) : (
              <span className="flex flex-col gap-0.5">
                {doc.live.services.map((name) => {
                  const d = doc.services.find((x) => x.name === name);
                  return (
                    <span key={name} className="font-mono text-[11.5px]">
                      {name} · {d ? (d.externalHost ? `${d.externalHost}:${d.externalPort ?? d.internalPort} (dış)` : d.image) : (
                        <span className="font-sans text-err-ink">services içinde tanımsız</span>
                      )}
                      {d?.optional && <span className="ml-1 font-sans text-ink-muted">(isteğe bağlı)</span>}
                    </span>
                  );
                })}
              </span>
            )}
          </Row>
          {doc.live.cloneDb && (
            <Row label="DB klonu" mono>
              {doc.database.clone.service} · şablon {doc.database.clone.template || `${doc.slug}_golden`}
            </Row>
          )}
          <Row label="Hazır sayılma">
            HTTP {doc.live.healthcheck.port !== undefined ? `:${doc.live.healthcheck.port}` : ""}
            {doc.live.healthcheck.path} →{doc.live.healthcheck.expectStatus.join("/")}
            {doc.live.readiness ? (
              <span className="mt-0.5 block text-[11.5px]">
                <span className="text-ink-muted">ve log'da</span>{" "}
                <span className="font-mono">{doc.live.readiness.logPattern}</span>
                <span className="text-ink-muted"> ({">"} {doc.live.readiness.minCaptureValue})</span>
              </span>
            ) : (
              <span className="mt-0.5 block text-[11.5px] text-wait-ink">
                log ölçütü yok — "port açık" hazır sayılacak
              </span>
            )}
          </Row>
          {doc.live.emptyEnv.length > 0 && (
            <Row label="Tek boşluk geçilir">
              <List items={doc.live.emptyEnv} />
              <span className="mt-0.5 block text-[11.5px] text-ink-muted">
                boş dize değişkeni siler; "tanımlı ama erişilemez" hâli uygulamayı öldürür
              </span>
            </Row>
          )}
          <Row label="Süre">
            {doc.live.ttlMinutes} dk · erişim {doc.live.access}
            {!doc.live.allowEgress && <span className="text-ink-muted"> · dış ağ kapalı</span>}
          </Row>
          <Row label="DAST">
            {/* Eski belgede alan yok; yokluk "kapalı" demek. */}
            {doc.live.dast?.enabled
              ? `kapıdan önce ${doc.live.dast.steps.map((s) => `${s.id} ${s.enabled ? "✓" : "✗"}`).join(" · ")} · eşik ${doc.live.dast.minRisk}+ · ${
                  doc.live.dast.autoFix ? "eşik üstü Developer'a otomatik" : "bulgular kapıda"
                } · ${
                  // Eski belgede `scope` yok; o zamanki davranış tam taramaydı.
                  doc.live.dast.scope?.mode === "branch" && doc.live.dast.scope.routePattern
                    ? `dalın uçları (yoksa ${doc.live.dast.scope.whenEmpty === "skip" ? "atla" : "tam tara"})`
                    : "tüm uygulama"
                }`
              : "kapalı"}
          </Row>
        </Section>
      )}

      {doc.database.kind !== "none" && (
        <Section title="Veritabanı" note="golden bir kez kurulur, iş başına klonlanır">
          <Row label="Tür">{doc.database.kind}</Row>
          {doc.database.migrate && (
            <div className="py-1">
              <div className="text-[11.5px] text-ink-muted">migration (yalnız şema)</div>
              <Cmd run={doc.database.migrate.run} />
            </div>
          )}
          <div className="py-1">
            <div className="text-[11.5px] text-ink-muted">tohum (AYRI adım)</div>
            {doc.database.seed ? (
              <Cmd run={doc.database.seed.run} />
            ) : (
              <span className="text-[12px] text-wait-ink">
                yok — tohumsuz veritabanında uçlar yetkisiz dönebilir
              </span>
            )}
          </div>
          <Row label="Bayatlık">{doc.database.goldenMaxAgeDays} günden eskiyse yeniden kurulur</Row>
        </Section>
      )}

      <Section title="Çalışma disiplini" note="motor değil profil karar verir">
        <Row label="Geliştirme">
          {doc.workflow.developing === "phased"
            ? `safhalı · safha başına en çok ${doc.workflow.phaseMaxFiles} dosya`
            : "tek blok"}
        </Row>
        <Row label="Safha sonunda">{doc.workflow.phaseRunsTests ? "test koşar" : "yalnız derleme"}</Row>
        <Row label="Commit">
          {doc.workflow.commitPolicy === "onApproval" ? "insan onayından sonra" : "otomatik"}
        </Row>
        <Row label="Kod incelemesi">
          {/* Motorun gerçekte baktığı alanlar: sağlayıcı PRReview'da beklemeyi
              açar; eskiden yalnız `autoTrigger` gösteriliyordu ve "otomatik"
              yazarken yorumlar hiç okunmuyordu. Eski belgede yeni alanlar
              olmayabilir — varsayılanlar yedek. */}
          {doc.workflow.review.provider === "none"
            ? "yok — PR açılınca CI'a geçilir"
            : `${doc.workflow.review.provider} beklenir · ${doc.workflow.review.minSeverity}+ yorum çözülür · en çok ${doc.workflow.review.maxRounds ?? 3} tur` +
              (doc.workflow.review.autoTrigger ? " · gerekirse tetiklenir" : "")}
        </Row>
        <Row label="Yerel ön inceleme">
          {/* Eski belgede alan yok; yokluk "kapalı" demek. */}
          {doc.workflow.review.local?.enabled
            ? `PR'dan önce ${doc.workflow.review.local.tool} · ${doc.workflow.review.local.protocol} · ${doc.workflow.review.local.model ?? "?"} · en çok ${doc.workflow.review.local.maxRounds} tur`
            : "kapalı"}
        </Row>
        <Row label="Statik analiz">
          {/* Eski belgede alan yok; yokluk "kapalı" demek. */}
          {doc.workflow.review.static?.enabled
            ? `PR'dan önce güvenlik: ${doc.workflow.review.static.steps.filter((s) => s.category === "security").map((s) => `${s.id} ${s.enabled ? "✓" : "✗"}`).join(" · ") || "—"}` +
              ` → kalite: ${doc.workflow.review.static.steps.filter((s) => s.category !== "security").map((s) => `${s.id} ${s.enabled ? "✓" : "✗"}`).join(" · ") || "—"}` +
              ` · en çok ${doc.workflow.review.static.maxRounds} tur${doc.workflow.review.static.securityGate ? " · güvenlik kapısı açık" : ""}`
            : "kapalı"}
        </Row>
        <Row label="PR">
          {doc.git.pr.provider === "none"
            ? "açılmaz"
            : `${doc.git.pr.provider} · ${doc.git.pr.draft ? "draft" : "hazır"} · taban ${doc.git.pr.base} · ${
                (doc.git.pr.openApproval ?? true) ? "onayla açılır" : "onaysız açılır"
              }`}
        </Row>
        <Row label="Dal">
          <span className="font-mono text-[11.5px]">{doc.git.branchPattern}</span>
          {!doc.git.branchRequired && <span className="text-ink-muted"> · zorunlu değil</span>}
        </Row>
      </Section>

      <Section title="Güvenlik" note="agent'ın göremeyeceği yerler">
        <Row label="Asla kopyalanmaz">
          {doc.security.neverCopy.length === 0 ? (
            <span className="text-wait-ink">boş — çalışma zamanı token'ları worktree'ye sızabilir</span>
          ) : (
            <span className="flex flex-wrap gap-1">
              {doc.security.neverCopy.map((p) => (
                <Danger key={p}>{p}</Danger>
              ))}
            </span>
          )}
        </Row>
        <Row label="Worktree'den silinir">
          <List items={doc.security.sensitiveFiles} empty="yok" />
        </Row>
        <Row label="Log okuma">
          {doc.security.logReadPolicy === "targeted" ? "hedefli (tail/regex)" : "tam dosya"}
        </Row>
      </Section>

      <Section title="Agent'lar ve sınırlar">
        {Object.entries(doc.agents.roles).map(([role, r]) => (
          <Row key={role} label={role}>
            {r.model} · {r.effort} · en çok {r.maxTurns} tur · ${r.maxBudgetUsd}
            {r.maxIterations ? ` · ${r.maxIterations} iterasyon` : ""}
          </Row>
        ))}
        {doc.agents.oversizedFiles.length > 0 && (
          <Row label="Ham okunmaz">
            <span className="flex flex-col gap-0.5">
              {doc.agents.oversizedFiles.map((f) => (
                <span key={f.path} className="font-mono text-[11.5px]">
                  {f.path}
                  {f.reason && <span className="ml-1 font-sans text-ink-muted">— {f.reason}</span>}
                </span>
              ))}
            </span>
          </Row>
        )}
        <Row label="Konteyner" mono>
          {doc.exec.image} · {doc.exec.resources.memory} · {doc.exec.resources.cpus} cpu
        </Row>
        {doc.exec.registries.length > 0 && (
          <Row label="Paket kaynakları">
            <span className="flex flex-col gap-0.5">
              {doc.exec.registries.map((r, i) => (
                <span key={i} className="font-mono text-[11.5px]">
                  {r.kind === "nuget" ? `NuGet ${r.source}` : `npm ${r.scope ?? "(varsayılan)"} → ${r.url}`}
                  <span className="ml-1 font-sans text-ink-muted">· token {r.tokenEnv}</span>
                </span>
              ))}
            </span>
          </Row>
        )}
        <Row label="Döngü tavanı">
          build {doc.limits.maxLoops.build} · qa {doc.limits.maxLoops.qa} · canlı {doc.limits.maxLoops.live}
          <span className="text-ink-muted"> · soru {doc.limits.askTimeoutMinutes} dk</span>
        </Row>
      </Section>

      <div className="flex items-center gap-1.5 text-[11.5px] text-ink-muted">
        <Dot tone="off" size={6} />
        Alanların tamamı için ham JSON'a bakın.
      </div>
    </div>
  );
}
