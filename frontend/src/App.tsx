import { useState, useEffect } from "preact/hooks";
import { html } from "htm/preact";
import { SessionList } from "./pages/SessionList";
import { SessionDetail } from "./pages/SessionDetail";
import { Settings } from "./pages/Settings";
import { parseHash, type ParsedHash } from "./lib/url-state";

function useRoute(): ParsedHash {
  const [parsed, setParsed] = useState<ParsedHash>(() => parseHash(location.hash || "#/"));
  useEffect(() => {
    const onHashChange = () => setParsed(parseHash(location.hash || "#/"));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return parsed;
}

function Nav() {
  const { path } = useRoute();
  return html`
    <nav>
      <div class="brand">claude<span class="brand-accent">monitor</span></div>
      <div class="nav-links">
        <a href="#/" class=${path === "/" ? "active" : ""}>Sessions</a>
        <a href="#/settings" class=${path === "/settings" ? "active" : ""}>Settings</a>
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
  const { path, params } = useRoute();

  let page;
  if (path === "/") {
    page = html`<${SessionList} params=${params} />`;
  } else if (path === "/settings") {
    page = html`<${Settings} />`;
  } else if (path.startsWith("/session/")) {
    const id = path.slice("/session/".length);
    page = html`<${SessionDetail} id=${id} params=${params} />`;
  } else {
    page = html`<${NotFound} />`;
  }

  return html`
    <${Nav} />
    ${page}
  `;
}
