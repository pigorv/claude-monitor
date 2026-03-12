import { useState, useEffect } from "preact/hooks";
import { html } from "htm/preact";
import { SessionList } from "./pages/SessionList";
import { SessionDetail } from "./pages/SessionDetail";
import { Settings } from "./pages/Settings";

function useRoute(): string {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const onHashChange = () => setHash(location.hash || "#/");
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return hash.slice(1); // strip leading '#'
}

function Nav() {
  const route = useRoute();
  return html`
    <nav>
      <div class="brand">claude<span class="brand-accent">monitor</span></div>
      <div class="nav-links">
        <a href="#/" class=${route === "/" ? "active" : ""}>Sessions</a>
        <a href="#/settings" class=${route === "/settings" ? "active" : ""}>Settings</a>
      </div>
    </nav>
  `;
}

function NotFound() {
  return html`
    <div class="page">
      <h1>404</h1>
      <p>Page not found. <a href="#/">Go to sessions</a></p>
    </div>
  `;
}

export function App() {
  const route = useRoute();

  let page;
  if (route === "/") {
    page = html`<${SessionList} />`;
  } else if (route === "/settings") {
    page = html`<${Settings} />`;
  } else if (route.startsWith("/session/")) {
    const id = route.slice("/session/".length);
    page = html`<${SessionDetail} id=${id} />`;
  } else {
    page = html`<${NotFound} />`;
  }

  return html`
    <${Nav} />
    ${page}
  `;
}
