// Pure predicate for "user has an active text selection." Lives in lib/ so it
// can be unit-tested without jsdom; the DOM-bound caller in EventCard.tsx feeds
// it `window.getSelection()?.toString()`. Mirrors the lib/url-state.ts split:
// pure logic here, DOM glue in the component.
export function hasNonEmptySelection(text: string | null | undefined): boolean {
  return (text ?? "").length > 0;
}
