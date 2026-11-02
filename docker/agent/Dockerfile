# Agent taban imajı — köprü + Claude Agent SDK.
#
# Elle build EDİLMEZ: sunucu bu tarifi kendi dosyalarından build eder ve
# içerik parmak izini `ahtapot.base` etiketiyle yazar (bkz.
# packages/server/src/exec/agentBase.ts). Bağlam: repo kökü (sunucu
# imajında /opt/ahtapot); `dist/` önceden derlenmiş olmalı;
# node_modules KOPYALANMAZ — SDK'nın CLI'sı platforma özel opsiyonel paketlerde
# (linux-x64 vb.) gelir, Linux içinde kurulmak zorunda.
#
# Proje imajları bunun üstüne kurulur: FROM ahtapot/agent-base + dotnet/npm.
FROM node:24-bookworm-slim

# `python3`: QA ve DevOps turlarında agent tek satırlık ayrıştırma/hesap için
# ona uzanıyor ve yokluğu **çıkış 127** ile düşüyordu (ölçüldü 2026-09-17).
# `bash` zaten var (imajın kendi tabanında), ayrıca kurulmuyor.
#
# `postgresql-client`: entegrasyon testleri şablon DB'den taze klon türetiyor
# (`CREATE DATABASE ... TEMPLATE`). Testler tohum atmaz, kurulu DB ister ve
# canlı veritabanına yazmamalı — ön adım `psql` ile klonluyor.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl python3 postgresql-client \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI — PR açmak ve CI izlemek için.
#
# YAŞANDI (2026-09-17): `gh` imajda yoktu; PR safhası `git push` aşamasında
# `could not read Username for 'https://github.com'` ile düştü. Konteynerde
# tty yok, git credential helper soramıyor. Çözüm iki parçalı: `gh` burada
# kurulur, kimlik ise `git/github.ts` içinde `gh auth setup-git` ile git'e
# devredilir — token `process.env`e YAZILMAZ, çağrı başına geçer (kural 5).
#
# apt deposu yerine resmî tarball: Debian bookworm `gh` taşımıyor ve GitHub'ın
# apt deposunu eklemek fazladan anahtar yönetimi demek.
ARG GH_VERSION=2.63.2
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) ghArch=amd64 ;; \
      arm64) ghArch=arm64 ;; \
      *) echo "desteklenmeyen mimari: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ghArch}.tar.gz" \
      -o /tmp/gh.tar.gz; \
    tar -xzf /tmp/gh.tar.gz -C /tmp; \
    install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${ghArch}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${ghArch}"; \
    gh --version

# OpenCodeReview — PR öncesi yerel ön inceleme (profil `workflow.review.local`).
#
# Resmî statik binary, yayının `sha256sum.txt`ine karşı doğrulanır. Araç git
# >= 2.41 istiyor, bookworm 2.39 taşıyor (backports'ta da yok); kontrol
# yalnız UYARI basıyor ve dosya seçimi 2.39'da ölçüldü, çalışıyor
# (2026-09-26, v1.12.9). Anahtar burada DEĞİL: exec başına ortamla gelir.
ARG OCR_VERSION=1.12.9
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64|arm64) ;; \
      *) echo "desteklenmeyen mimari: $arch" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/alibaba/open-code-review/releases/download/v${OCR_VERSION}"; \
    curl -fsSL "$base/opencodereview-linux-${arch}" -o /tmp/opencodereview-linux-${arch}; \
    curl -fsSL "$base/sha256sum.txt" -o /tmp/ocr.sha256; \
    (cd /tmp && grep " opencodereview-linux-${arch}\$" ocr.sha256 | sha256sum -c -); \
    install -m 0755 "/tmp/opencodereview-linux-${arch}" /usr/local/bin/ocr; \
    rm -f "/tmp/opencodereview-linux-${arch}" /tmp/ocr.sha256; \
    ocr version

# Playwright MCP + Chromium — canlı testte tarayıcı turu.
#
# Köprü bu yolu arar; yoksa `browser` yeteneğini bildirmez ve sunucu turu
# atlar. Sürüm sabit: MCP'nin bağımlı olduğu `playwright` sürümü tarayıcı
# derlemesini belirler, `latest` her kurulumda başka bir Chromium getirirdi.
# `--with-deps` apt kurar, bu yüzden kök kullanıcıyla ve USER node'dan önce.
# Kurulum ~400 MB; ayrı katman, köprü değişince yeniden indirilmez.
ARG PLAYWRIGHT_MCP_VERSION=0.0.83
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN set -eux; \
    npm install --prefix /opt/playwright-mcp --omit=dev --no-fund --no-audit "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}"; \
    node /opt/playwright-mcp/node_modules/playwright/cli.js install --with-deps chromium; \
    rm -rf /var/lib/apt/lists/* /root/.npm; \
    chmod -R a+rX /opt/ms-playwright /opt/playwright-mcp; \
    node /opt/playwright-mcp/node_modules/@playwright/mcp/cli.js --version

# Trail kod grafiği — tree-sitter ile sembol + çağrı grafiği, MCP ile
# sunulur (profil `agents.codeGraph`).
#
# Köprü bu yolu arar; yoksa `codegraph` yeteneğini bildirmez. `trail`
# PATH'te: motor grafiği `executor` ile kurar. `--ignore-scripts`:
# postinstall yalnız anonim "kuruldu" olayı yolluyor; tree-sitter hazır
# binary'lerle (linux-x64/arm64) betiksiz çalışıyor (ölçüldü, 0.23.1).
# Sürüm sabit: grafik biçimi sürümler arasında değişiyor.
ARG TRAIL_VERSION=0.23.1
RUN set -eux; \
    npm install --prefix /opt/trail-code --omit=dev --ignore-scripts --no-fund --no-audit "@trailhq/trail-code@${TRAIL_VERSION}"; \
    ln -s /opt/trail-code/node_modules/.bin/trail /usr/local/bin/trail; \
    rm -rf /root/.npm; \
    chmod -R a+rX /opt/trail-code; \
    DO_NOT_TRACK=1 HOME=/tmp trail --version

WORKDIR /opt/ahtapot

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/bridge/package.json packages/bridge/
RUN npm ci --workspace=@ahtapot/shared --workspace=@ahtapot/bridge --omit=dev --ignore-scripts

COPY packages/shared/dist packages/shared/dist
COPY packages/bridge/dist packages/bridge/dist

# Kök değil: cap-drop ALL + no-new-privileges ile birlikte sınırı çizer.
RUN chown -R node:node /opt/ahtapot
USER node
ENV HOME=/home/node
WORKDIR /workspace

ENTRYPOINT ["node", "/opt/ahtapot/packages/bridge/dist/main.js"]
