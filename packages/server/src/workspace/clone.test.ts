import { test } from "node:test";
import assert from "node:assert/strict";

import type { CommandExecutor, ExecRequest, ExecResult } from "../build/executor.js";
import { cloneWorkspace } from "./clone.js";

/**
 * YAŞANDI: `ExecRequest.onLine`in gerçek imzası `(stream, line) => void`.
 * `cloneWorkspace` eskiden tek parametreli `(line) => ...` yazıyordu — TS bunu
 * yapısal uyum yüzünden sessizce kabul etti (az parametreli callback, çok
 * parametre bekleyen yere atanabilir), ama çalışma zamanında `line`a giren
 * aslında `stream` ("stdout"/"stderr") oluyordu. Sonuç: klon hatası mesajı
 * gerçek git çıktısı yerine tekrarlanan "stderr" kelimeleriyle doluyordu.
 *
 * Bu test gerçek `git`/`gh` koşturmaz — `exec.run` tamamen sahte, yalnız
 * `onLine`ı `ExecRequest`teki GERÇEK imzayla (`stream`, `line`) çağırır ve
 * `cloneWorkspace`in bunu doğru sırayla okuyup okumadığını denetler.
 */
test("cloneWorkspace: onLine'a giden metin stream adı DEĞİL gerçek satır olmalı", async () => {
  const seen: Array<[string, string]> = [];

  const fakeExec: CommandExecutor = {
    run(req: ExecRequest): Promise<ExecResult> {
      // Klon adımı: bir stderr satırı yayınla, sonra başarısız dön.
      if (req.command.includes("git clone")) {
        req.onLine("stderr", "fatal: repository not found");
        return Promise.resolve({ exitCode: 128, durationMs: 1, timedOut: false });
      }
      // Temizlik (`rm -rf` geçici dizin) — başarı say.
      return Promise.resolve({ exitCode: 0, durationMs: 1, timedOut: false });
    },
  };

  await assert.rejects(
    () =>
      cloneWorkspace(fakeExec, "https://example.invalid/owner/repo.git", "/tmp/hedef", {
        onLine: (stream, line) => seen.push([stream, line]),
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      // Kusurlu haldeyken burada "stderr" (stream adı) görünürdü; düzeltilmiş
      // haliyle git'in gerçek çıktısı görünmeli.
      assert.match(err.message, /fatal: repository not found/);
      assert.doesNotMatch(err.message, /\nstderr$/);
      return true;
    },
  );

  assert.deepEqual(seen, [["stderr", "fatal: repository not found"]]);
});
