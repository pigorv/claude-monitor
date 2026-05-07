import { useEffect, useState } from "preact/hooks";
import { html } from "htm/preact";

// Floating "↑ Top" button that appears once the user has scrolled past
// roughly two viewports. Window-scroll only — pages with their own scroll
// container would need a different trigger.
export function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setVisible(window.scrollY > window.innerHeight * 2);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!visible) return null;

  return html`
    <button
      class="back-to-top"
      title="Back to top"
      aria-label="Back to top"
      onClick=${() => window.scrollTo({ top: 0, behavior: "smooth" })}
    >
      ↑ Top
    </button>
  `;
}
