import { render } from "preact";
import { html } from "htm/preact";
import { App } from "./App";
import "./styles/globals.css";

render(html`<${App} />`, document.getElementById("app")!);
