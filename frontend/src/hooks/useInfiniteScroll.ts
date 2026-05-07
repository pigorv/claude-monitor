import { useEffect, useRef, type RefObject } from "preact/hooks";

interface InfiniteScrollOptions {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  rootMargin?: string;
}

// Observes a sentinel element and fires `onLoadMore` when it scrolls into view.
// Re-entrant intersections are ignored while `loading` is true so a fast scroll
// doesn't fire overlapping requests.
export function useInfiniteScroll(
  sentinelRef: RefObject<HTMLElement | null>,
  { hasMore, loading, onLoadMore, rootMargin = "200px" }: InfiniteScrollOptions,
): void {
  const cbRef = useRef(onLoadMore);
  cbRef.current = onLoadMore;

  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !loadingRef.current) {
            cbRef.current();
          }
        }
      },
      { rootMargin },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [sentinelRef, hasMore, rootMargin]);
}
