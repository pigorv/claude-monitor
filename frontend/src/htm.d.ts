declare module "htm/preact" {
  import { VNode } from "preact";
  export function html(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): VNode;
}
