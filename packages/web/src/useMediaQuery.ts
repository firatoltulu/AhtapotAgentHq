import { useEffect, useState } from "react";

/**
 * CSS kırılımını JS tarafında okur.
 *
 * Sohbet xl'de sağ sütuna taşınıyor; hangi sekmelerin gösterileceği ve
 * Composer'ın nereye konacağı buna bağlı. Sadece CSS ile gizlemek yetmez —
 * iki Composer birden render edilirse aynı iş için iki metin kutusu olur.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent): void => setMatches(e.matches);
    setMatches(mq.matches); // query değişmişse ilk değeri tazele
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
