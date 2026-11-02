# AhtapotAgent'ın kendi server+web imajı (7717) — hedef proje sandbox
# imajlarından (docker/agent + Analyst'in her workspace için ürettiği
# proje-özel Dockerfile'lar) AYRI: bu, motorun/UI'ın kendisi.
#
# Bağlam: repo kökü. `better-sqlite3` native modül taşıdığı için node_modules
# HOST'tan kopyalanmaz — docker/agent/Dockerfile'daki gerekçenin aynısı:
# platforma özel derleme Linux konteyner İÇİNDE yapılmak zorunda.
#
# İki aşama: builder tüm workspace'i (shared+server+web) derler, runtime
# yalnız üretim bağımlılıklarını + derlenmiş dist'leri taşır.

FROM node:24-bookworm-slim AS builder
WORKDIR /opt/ahtapot

# better-sqlite3 derlemesi için: python3 + build-essential (node-gyp ister).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/bridge/package.json packages/bridge/
RUN npm ci

COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/web packages/web
COPY packages/bridge packages/bridge
COPY agents agents
RUN npm run build --workspace=@ahtapot/shared \
 && npm run build --workspace=@ahtapot/server \
 && npm run build --workspace=@ahtapot/bridge \
 && npm run build --workspace=@ahtapot/web

# Yalnız üretim bağımlılıkları — devDependencies (typescript, vite, vb.) hariç.
RUN npm ci --omit=dev --workspace=@ahtapot/server --workspace=@ahtapot/shared --ignore-scripts \
 && npm rebuild better-sqlite3 --workspace=@ahtapot/server \
 && mkdir -p packages/server/node_modules

FROM node:24-bookworm-slim AS runtime
# Northwind .NET araç zincirini derlerken kullanılan `git`: server, canlı ortam
# kaldırma/PR akışında host git'ine değil kendi içine ihtiyaç duymaz — yalnız
# ca-certificates gerekli (Anthropic API / GitHub API TLS için).
#
# `gh` CLI ZORUNLU: github.ts (push, createDraftPr, merge, listIssues,
# listRepos, cloneWorkspace) hepsi `gh`/`git` komutunu spawn ediyor. Önceden
# yalnız host'ta kurulu olduğu varsayılmıştı — konteynerde spawn `ENOENT` ile
# düşüyordu (YAŞANDI). `git` de `gh auth setup-git` + `git clone`/`push` için
# gerekli, host'taki gibi ayrıca kurulmalı.
# `gosu`: entrypoint root olarak docker.sock'un GID'ini ayarladıktan sonra
# asıl process'i `node` kullanıcısına düşürmek için (bkz. entrypoint.sh).
#
# `docker` CLI + compose eklentisi ZORUNLU: agent konteynerleri dockerode ile
# (soket üzerinden) kalkıyor ve CLI istemiyor, ama CANLI ORTAM
# (`live/environment.ts`) `docker compose`u spawn ediyor — compose'un Node API'si
# yok. CLI yokken her canlı ortam "spawn docker ENOENT" ile düştü (YAŞANDI,
# 2026-09-22). Yalnız İSTEMCİ kurulur (`docker-ce-cli`), daemon değil: host'un
# mount edilen docker.sock'una konuşur, Docker-in-Docker yine YOK.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gnupg gosu \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod go+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh docker-ce-cli docker-compose-plugin \
 && apt-get purge -y curl gnupg \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/ahtapot
ENV NODE_ENV=production

# npm workspaces bağımlılıkları kök node_modules'a hoist eder; paket-özel
# node_modules oluşmaz (@ahtapot/shared bile kökte symlink). Ayrı ayrı
# kopyalamaya çalışmak "not found" ile düşerdi (yaşandı) — tek kök yeterli.
#
# İSTİSNA: @anthropic-ai/claude-agent-sdk (platforma özel optionalDependency
# taşıyor) kökte HOİST OLMUYOR, yalnız packages/server/node_modules'ta kalıyor
# — kök kopyası bu paketi atlar, `dist/main.js` açılışta "Cannot find module"
# ile düşer. Paket-özel klasör de ayrıca kopyalanır.
# Hoist kararı lock'a bağlı: bridge ile sunucunun SDK aralığı ayrışınca
# sunucununki köke çıkıyor ve bu klasör hiç oluşmuyor — COPY "not found" ile
# düştü (v1.16.0, yaşandı). Builder'daki `mkdir -p` iki durumu da karşılar.
COPY --from=builder /opt/ahtapot/node_modules node_modules
COPY --from=builder /opt/ahtapot/package.json ./
COPY --from=builder /opt/ahtapot/packages/shared/dist packages/shared/dist
COPY --from=builder /opt/ahtapot/packages/shared/package.json packages/shared/package.json
COPY --from=builder /opt/ahtapot/packages/server/dist packages/server/dist
COPY --from=builder /opt/ahtapot/packages/server/package.json packages/server/package.json
COPY --from=builder /opt/ahtapot/packages/server/node_modules packages/server/node_modules
# migrate.ts çalışma anında dist/db/migrate.js'ten ../../drizzle'a bakıyor
# (kaynak, derlenmiş çıktıya kopyalanmıyor) — bu klasör olmadan açılışta
# "Can't find meta/_journal.json file" ile düşer (yaşandı).
COPY --from=builder /opt/ahtapot/packages/server/drizzle packages/server/drizzle
COPY --from=builder /opt/ahtapot/packages/web/dist packages/web/dist
# Rol promptları (agents/core/<rol>.md): `loadRolePrompt` çalışma anında
# dist/agents/prompts.js'ten 4 üst dizine (repo köküne) çıkıp buradan okuyor.
# Bu klasör kopyalanmadan "analiz et" ilk agent çağrısında ENOENT ile düşer
# (yaşandı) — build hatasız geçer, yalnız çalışma anında patlar.
COPY --from=builder /opt/ahtapot/agents agents

# Agent tabanının build bağlamı (`exec/agentBase.ts`): sunucu tabanı bu
# dosyalardan KENDİSİ build eder — ayrı bir registry paketi ve elle
# `pull` + `tag` yok. Düzen repo köküyle aynı olmalı; tarif
# (`docker/agent/Dockerfile`) yolları köke göreli COPY ediyor. Köprünün
# bağımlılıkları buraya KURULMAZ: tabanın içinde `npm ci` ile kurulur.
COPY --from=builder /opt/ahtapot/package-lock.json ./
COPY --from=builder /opt/ahtapot/packages/bridge/package.json packages/bridge/package.json
COPY --from=builder /opt/ahtapot/packages/bridge/dist packages/bridge/dist
COPY docker/agent/Dockerfile docker/agent/Dockerfile

RUN chown -R node:node /opt/ahtapot

# Kök değil ÇALIŞIR (docker/agent/Dockerfile ile aynı disiplin) — ama kök
# olarak BAŞLAR: docker.sock'un GID'i host'a göre değişir (sabit varsayım
# YAŞANDI: bir sunucuda 999 değil 983 çıktı, `node` yanlış gruba eklenmiş
# oluyordu ve `dockerode.ping()` sessizce EACCES ile düşüyordu). Entrypoint
# GID'i her açılışta okuyup `node`yu doğru gruba ekler, sonra `gosu` ile
# asıl process'i `node`ya düşürür — kalıcı kök yetkisi taşınmaz.
COPY docker/server/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Sürüm UI'da görünür (`src/version.ts`). İmajda `.git` yok; yayın workflow'u
# sürümü build'den önce `version.txt`e yazar (repoda `dev`). En sonda: her
# yayında değişen dosya yalnız bu katmanı bozar, bağımlılık ve derleme
# katmanları önbellekte kalır.
COPY version.txt version.txt

EXPOSE 7717
WORKDIR /opt/ahtapot/packages/server
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/main.js"]
