/**
 * Feishu interactive card templates (future enhancement).
 *
 * When `feishuCards` config is enabled, these templates will be used
 * to send rich interactive cards instead of plain text messages.
 * Currently a stub — plain text feedback is sent for all channels.
 */

export type FeishuCardTemplate = {
  header: { title: string; template?: string };
  elements: FeishuCardElement[];
};

export type FeishuCardElement =
  | { tag: "div"; text: { tag: "plain_text" | "lark_md"; content: string } }
  | { tag: "hr" }
  | { tag: "note"; elements: Array<{ tag: "plain_text"; content: string }> };

export function buildStatusCard(
  title: string,
  body: string,
  color = "blue",
): FeishuCardTemplate {
  return {
    header: { title, template: color },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: body } },
    ],
  };
}

export function buildErrorCard(
  title: string,
  body: string,
): FeishuCardTemplate {
  return buildStatusCard(title, body, "red");
}

export function buildSuccessCard(
  title: string,
  body: string,
): FeishuCardTemplate {
  return buildStatusCard(title, body, "green");
}
