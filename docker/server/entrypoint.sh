#!/bin/sh
set -e

# docker.sock'un GID'i HOST'A GÖRE DEĞİŞİR — sabit değildir. Dockerfile'da
# eskiden build zamanında GID 999 varsayılıyordu; bir üretim sunucusunda
# gerçek GID 983 çıktı ve `node` kullanıcısı hiç eşleşmeyen bir gruba
# eklenmiş oluyordu. Sonuç: `dockerode.ping()` EACCES ile düşüyor, ama
# `available()` hatayı yutup `false` döndürdüğü için ekranda yalnız
# "Docker erişilemiyor; Developer konteyneri kurulamadı" görünüyordu —
# kök neden loglara hiç düşmüyordu (YAŞANDI, 2026-09-19).
#
# Çözüm: GID'i BUILD ZAMANINDA DEĞİL, HER AÇILIŞTA sock'tan oku ve `node`
# kullanıcısını o gruba ekle. Container bu yüzden ROOT olarak başlıyor
# (yalnız bu script koşarken); asıl process `gosu` ile `node`ya düşürülüyor.
SOCK=/var/run/docker.sock

if [ -S "$SOCK" ]; then
  SOCK_GID="$(stat -c '%g' "$SOCK")"
  # Bu GID'de zaten bir grup varsa onu kullan, yoksa yeni oluştur — iki host
  # aynı GID'i farklı adla kullanıyor olabilir, isim önemli değil.
  GROUP_NAME="$(getent group "$SOCK_GID" | cut -d: -f1 || true)"
  if [ -z "$GROUP_NAME" ]; then
    GROUP_NAME="docker-host"
    groupadd -g "$SOCK_GID" "$GROUP_NAME"
  fi
  usermod -aG "$GROUP_NAME" node
else
  # Sock mount edilmemiş: Developer rolü zaten çalışamayacak, ama sunucunun
  # geri kalanı (profil, plan, onay ekranları) hâlâ işe yarar — burada
  # durmuyoruz, `ContainerManager.available()` bunu zaten yakalayıp
  # "Docker erişilemiyor" diye bildirecek.
  echo "uyarı: $SOCK bulunamadı — Developer/canlı ortam adımları çalışmayacak" >&2
fi

exec gosu node "$@"
