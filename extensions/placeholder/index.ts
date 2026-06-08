import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function placeholderExtension(pi: ExtensionAPI) {
  pi.registerCommand("placeholder-extension", {
    description: "Confirm the placeholder extension is loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify("placeholder extension loaded", "info");
    },
  });
}
