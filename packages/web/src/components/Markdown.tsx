import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { htmlAttr, isGithubAttachment, mapOutsideCode } from "@ahtapot/shared";

/**
 * GitHub biçimli markdown (tablo, görev listesi, üstü çizili). Ham HTML
 * işlenmez (`skipHtml`): issue gövdesi dışarıdan gelir, güvenilmez metindir —
 * `<details>` gibi etiketler düşer ama içerikleri metin olarak kalır.
 */
export function Markdown({ children, baseUrl }: { children: string; baseUrl?: string | undefined }) {
  // Göreli bağlantılar (`../pull/12`, `/org/repo/issues/3`) GitHub'a göre
  // yazılmıştır; çözülmezse Ahtapot'un kendi rotalarına gider.
  const components = useMemo<Components>(() => ({
    ...COMPONENTS,
    a: ({ href, children }) => {
      if (!href || href.startsWith("#")) return <a href={href}>{children}</a>;
      return (
        <a href={resolve(href, baseUrl)} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    img: ({ src, alt }) => {
      if (typeof src !== "string") return null;
      const url = resolve(src, baseUrl);
      // Güvenilmez gövdedeki görsel, sayfa açılır açılmaz izleyicinin
      // tarayıcısından istek atar (izleme pikseli). Yalnız GitHub'ın kendi
      // ek sunucuları otomatik yüklenir; gerisi tıklanınca açılan bağlantı.
      if (isGithubAttachment(url)) return <img src={url} alt={alt ?? ""} className="max-w-full rounded-md" />;
      return (
        <a href={url} target="_blank" rel="noreferrer">
          [görsel{alt ? `: ${alt}` : ""}]
        </a>
      );
    },
  }), [baseUrl]);

  return (
    <div className="flex flex-col gap-2.5">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {htmlImagesToMarkdown(children)}
      </ReactMarkdown>
    </div>
  );
}

/**
 * GitHub, sürüklenip bırakılan görseli `<img width=… src=…>` olarak yazar;
 * `skipHtml` bunu iz bırakmadan düşürür ve ekran görüntüsü kaybolur. Etiket
 * markdown görseline çevrilir ki `img` bileşeninin kaynak denetiminden geçsin.
 * Kod (çitli blok, satır içi) içine dokunulmaz — orada etiket metin olarak kalmalı.
 */
function htmlImagesToMarkdown(md: string): string {
  return mapOutsideCode(md, (part) =>
    part.replace(/<img\b[^>]*>/gi, (tag) => {
      const src = htmlAttr(tag, "src");
      if (!src) return tag;
      const alt = (htmlAttr(tag, "alt") ?? "").replace(/[[\]]/g, "");
      return `![${alt}](<${src}>)`;
    }),
  );
}

function resolve(href: string, baseUrl: string | undefined): string {
  if (!baseUrl) return href;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="border-b border-edge pb-1 text-[16px] font-semibold text-ink">{children}</h1>,
  h2: ({ children }) => <h2 className="border-b border-edge pb-1 text-[15px] font-semibold text-ink">{children}</h2>,
  h3: ({ children }) => <h3 className="text-[14px] font-semibold text-ink">{children}</h3>,
  h4: ({ children }) => <h4 className="text-[13px] font-semibold text-ink">{children}</h4>,
  h5: ({ children }) => <h5 className="text-[13px] font-semibold text-ink-soft">{children}</h5>,
  h6: ({ children }) => <h6 className="text-[12.5px] font-semibold text-ink-soft">{children}</h6>,
  p: ({ children }) => <p className="m-0">{children}</p>,
  ul: ({ children, className }) => (
    <ul className={`m-0 flex flex-col gap-1 ${className?.includes("contains-task-list") ? "list-none pl-1" : "list-disc pl-5"}`}>
      {children}
    </ul>
  ),
  ol: ({ children }) => <ol className="m-0 flex list-decimal flex-col gap-1 pl-5">{children}</ol>,
  input: ({ checked }) => <input type="checkbox" checked={Boolean(checked)} disabled className="mr-1.5 align-middle" />,
  blockquote: ({ children }) => (
    <blockquote className="m-0 flex flex-col gap-2 border-l-[3px] border-edge-strong pl-3 text-ink-soft">{children}</blockquote>
  ),
  // Satır içi kod ile blok kod aynı etiketi (`code`) kullanır; blok olan `pre`
  // tarafından sarılır, çerçeveyi o çizer.
  code: ({ children }) => <code className="rounded bg-chip px-1 py-px font-mono text-[12px]">{children}</code>,
  pre: ({ children }) => (
    <pre className="m-0 overflow-auto rounded-lg border border-edge bg-sunken px-3 py-2 font-mono text-[12px] leading-[1.55] [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="overflow-auto">
      <table className="border-collapse text-[12.5px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-edge bg-sunken px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-edge px-2 py-1">{children}</td>,
  hr: () => <hr className="my-1 border-edge" />,
};
